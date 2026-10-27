import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { createLogger } from '@shared/log';
import type { Preset, PresetDraft, PresetSection } from '@shared/model';
import type { Treatments } from '@shared/preset';
import {
  applyPreset,
  byName,
  presetIssue,
  presetMatches,
  presetSections,
  presetValues,
} from '@shared/preset';
import { DESKTOP, ipcErrorMessage } from './desktop';
import { SettingsStore } from './settings-store';

const log = createLogger('presets');

/**
 * The presets, persisted by the main process: treatments saved under a name, each setting some
 * sections of the panel. The one applied last is the current one, until another is chosen.
 */
@Injectable({ providedIn: 'root' })
export class PresetsStore {
  private readonly desktop = inject(DESKTOP);
  private readonly settings = inject(SettingsStore);
  private readonly list = signal<readonly Preset[]>([]);
  /** A change arrived: the initial listing, if still on its way, is older. */
  private changed = false;

  /** By name, as the menu lists them. */
  readonly presets = computed(() => [...this.list()].sort(byName));
  /** The preset applied last, while it exists. */
  readonly current = computed(() => {
    const id = this.settings.presetId();
    return id === null ? null : (this.list().find((preset) => preset.id === id) ?? null);
  });
  /** Whether the treatments changed, since the current preset was applied, in what it sets. */
  readonly modified = computed(() => {
    const preset = this.current();
    return preset !== null && !presetMatches(preset, this.treatments());
  });

  constructor() {
    const unsubscribe = this.desktop.onPresetsChanged((presets) => {
      this.changed = true;
      this.list.set(presets);
    });
    inject(DestroyRef).onDestroy(unsubscribe);
    this.desktop
      .listPresets()
      .then((presets) => {
        if (!this.changed) {
          this.list.set(presets);
        }
      })
      .catch((error: unknown) => {
        log.error('Cannot list the presets:', error);
      });
  }

  /** Sets the sections `preset` holds to its values, and makes it the current preset. */
  apply(preset: Preset): void {
    const { recipe, output } = applyPreset(preset, this.treatments());
    this.settings.updateRecipe(recipe);
    if (preset.output !== undefined) {
      void this.settings.setOutput(output);
    }
    void this.settings.setPreset(preset.id);
  }

  /** No preset is the current one; the treatments stay as they are. */
  clear(): void {
    void this.settings.setPreset(null);
  }

  /**
   * Saves the treatments of `sections` as a new preset, which becomes the current one. Resolves
   * to why it could not be saved, in words for the user; `null` once saved.
   */
  async create(name: string, sections: readonly PresetSection[]): Promise<string | null> {
    const { recipe, output } = this.treatments();
    return this.save({ name, ...presetValues(recipe, output, sections) });
  }

  /** Saves the treatments as the new values of `preset`, for the sections it sets. */
  async update(preset: Preset): Promise<string | null> {
    const { recipe, output } = this.treatments();
    return this.save({
      id: preset.id,
      name: preset.name,
      ...presetValues(recipe, output, presetSections(preset)),
    });
  }

  async rename(preset: Preset, name: string): Promise<string | null> {
    return this.save({ ...preset, name });
  }

  /** Forgets a preset; the treatments it set stay as they are. */
  async remove(preset: Preset): Promise<string | null> {
    try {
      await this.desktop.removePreset(preset.id);
    } catch (error) {
      log.warn('Cannot delete a preset:', error);
      return `Cannot delete “${preset.name}”: ${ipcErrorMessage(error)}`;
    }
    this.list.update((presets) => presets.filter((candidate) => candidate.id !== preset.id));
    if (this.settings.presetId() === preset.id) {
      void this.settings.setPreset(null);
    }
    return null;
  }

  /** Why `draft` cannot be saved, checked before asking the main process; `null` when it can. */
  issue(draft: PresetDraft): string | null {
    return presetIssue(draft, this.list(), draft.id);
  }

  private async save(draft: PresetDraft): Promise<string | null> {
    const issue = this.issue(draft);
    if (issue !== null) {
      return issue;
    }
    let saved: Preset;
    try {
      saved = await this.desktop.savePreset(draft);
    } catch (error) {
      log.warn('Cannot save a preset:', error);
      return ipcErrorMessage(error);
    }
    // The new list may come later than the answer.
    this.list.update((presets) =>
      presets.some((preset) => preset.id === saved.id)
        ? presets.map((preset) => (preset.id === saved.id ? saved : preset))
        : [...presets, saved],
    );
    void this.settings.setPreset(saved.id);
    return null;
  }

  private treatments(): Treatments {
    return { recipe: this.settings.recipe(), output: this.settings.output() };
  }
}
