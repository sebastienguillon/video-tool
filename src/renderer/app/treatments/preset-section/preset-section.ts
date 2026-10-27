import type { ElementRef } from '@angular/core';
import {
  afterNextRender,
  Component,
  computed,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import type { Preset, PresetSection as Section, Trim } from '@shared/model';
import { PRESET_SECTIONS } from '@shared/model';
import { PRESET_NAME_MAX_LENGTH, presetSections } from '@shared/preset';
import { isTrimSet, silences, trims } from '@shared/recipe';
import { formatTime } from '@shared/time';
import { PresetsStore } from '../../core/presets-store';
import { SettingsStore } from '../../core/settings-store';
import { TracksStore } from '../../core/tracks-store';
import { Icon } from '../../ui/icon/icon';

/** As the panel's sections are titled. */
const LABELS: Readonly<Record<Section, string>> = {
  audio: 'Audio',
  silence: 'Silence',
  trim: 'Trim',
  output: 'Save to',
};

/** As a sentence names them. */
const NAMES: Readonly<Record<Section, string>> = {
  audio: 'the audio',
  silence: 'the silences',
  trim: 'the trims',
  output: 'where to save',
};

type Mode = 'browse' | 'save' | 'rename' | 'delete';

/**
 * Presets: apply one, save the treatments as a new one or as the new values of the current one,
 * rename or delete it. Saving, renaming and deleting take the place of the menu until done.
 */
@Component({
  selector: 'app-preset-section',
  imports: [Icon],
  templateUrl: './preset-section.html',
  styleUrl: './preset-section.css',
})
export class PresetSection {
  private readonly store = inject(PresetsStore);
  private readonly settings = inject(SettingsStore);
  private readonly tracks = inject(TracksStore);
  private readonly injector = inject(Injector);
  private readonly menu = viewChild<ElementRef<HTMLSelectElement>>('menu');
  private readonly saveButton = viewChild<ElementRef<HTMLButtonElement>>('saveButton');
  private readonly renameButton = viewChild<ElementRef<HTMLButtonElement>>('renameButton');
  private readonly deleteButton = viewChild<ElementRef<HTMLButtonElement>>('deleteButton');
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');
  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>('cancelButton');

  protected readonly sections = PRESET_SECTIONS;
  protected readonly labels = LABELS;
  protected readonly maxLength = PRESET_NAME_MAX_LENGTH;
  protected readonly presets = this.store.presets;
  protected readonly current = this.store.current;
  protected readonly modified = this.store.modified;
  protected readonly mode = signal<Mode>('browse');
  protected readonly name = signal('');
  protected readonly chosen = signal<ReadonlySet<Section>>(new Set());
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  /** What the current preset sets, and whether the treatments changed since it was applied. */
  protected readonly summary = computed(() => {
    const preset = this.current();
    if (preset === null) {
      return 'Choose one to set the treatments it holds.';
    }
    const sets = `Sets ${sentence(presetSections(preset).map((section) => NAMES[section]))}.`;
    return this.modified() ? `${sets} Changed since it was applied.` : sets;
  });
  /** The current preset replaces the audio with a soundtrack no longer in the audio list. */
  protected readonly trackMissing = computed(() => {
    const audio = this.current()?.audio;
    return (
      audio?.audio === 'replace' &&
      audio.trackId !== null &&
      !this.tracks.tracks().some((track) => track.id === audio.trackId)
    );
  });

  protected choose(event: Event): void {
    const id = (event.target as HTMLSelectElement).value;
    const preset = this.presets().find((candidate) => candidate.id === id);
    this.error.set(null);
    if (preset === undefined) {
      this.store.clear();
    } else {
      this.store.apply(preset);
    }
  }

  protected applyAgain(preset: Preset): void {
    this.error.set(null);
    this.store.apply(preset);
  }

  protected async update(preset: Preset): Promise<void> {
    await this.run(() => this.store.update(preset));
  }

  /** Every section the treatments make use of is ticked; where to save is not. */
  protected startSave(): void {
    const recipe = this.settings.recipe();
    this.name.set('');
    this.chosen.set(
      new Set<Section>([
        'audio',
        ...(silences(recipe) ? (['silence'] as const) : []),
        ...(trims(recipe) ? (['trim'] as const) : []),
      ]),
    );
    this.open('save');
  }

  protected startRename(preset: Preset): void {
    this.name.set(preset.name);
    this.open('rename');
  }

  protected startDelete(): void {
    this.open('delete');
  }

  protected setName(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
  }

  protected toggle(section: Section, event: Event): void {
    const next = new Set(this.chosen());
    if ((event.target as HTMLInputElement).checked) {
      next.add(section);
    } else {
      next.delete(section);
    }
    this.chosen.set(next);
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    const preset = this.current();
    switch (this.mode()) {
      case 'save': {
        const sections = this.sections.filter((section) => this.chosen().has(section));
        await this.finish(() => this.store.create(this.name(), sections), 'menu');
        break;
      }
      case 'rename':
        if (preset !== null) {
          await this.finish(() => this.store.rename(preset, this.name()), 'menu');
        }
        break;
      case 'delete':
        if (preset !== null) {
          await this.finish(() => this.store.remove(preset), 'save');
        }
        break;
      case 'browse':
        break;
    }
  }

  /** Cancel or Escape: nothing changes, and the focus goes back to what opened the form. */
  protected cancel(event?: Event): void {
    event?.preventDefault();
    const mode = this.mode();
    this.mode.set('browse');
    this.error.set(null);
    const openers = { rename: this.renameButton, delete: this.deleteButton } as const;
    this.afterRender(() => {
      const opener = mode === 'rename' || mode === 'delete' ? openers[mode] : this.saveButton;
      opener()?.nativeElement.focus();
    });
  }

  /** What a section of the treatments is now, as saving it in a preset would keep it. */
  protected describe(section: Section): string {
    const recipe = this.settings.recipe();
    switch (section) {
      case 'audio':
        return audioText(recipe.audio, this.tracks.selected()?.name ?? null, recipe.loop);
      case 'silence':
        return edgesText(recipe.silenceStart, recipe.silenceEnd);
      case 'trim':
        return trims(recipe)
          ? `${edgesText(recipe.trimStart, recipe.trimEnd)}, ${recipe.precision}`
          : 'None';
      case 'output': {
        const { location, folder } = this.settings.output();
        return location === 'beside' ? 'Next to each video' : (folder ?? 'In a folder, not chosen');
      }
    }
  }

  private open(mode: Mode): void {
    this.error.set(null);
    this.mode.set(mode);
    // Cancel is the safe default for deleting.
    this.afterRender(() =>
      (mode === 'delete' ? this.cancelButton() : this.nameInput())?.nativeElement.focus(),
    );
  }

  /** Runs an action of a form; once done, the form closes and the focus goes to `next`. */
  private async finish(action: () => Promise<string | null>, next: 'menu' | 'save'): Promise<void> {
    if (await this.run(action)) {
      this.mode.set('browse');
      this.afterRender(() =>
        (next === 'menu' ? this.menu() : this.saveButton())?.nativeElement.focus(),
      );
    }
  }

  /** Runs one action at a time; resolves to whether it succeeded, saying why not otherwise. */
  private async run(action: () => Promise<string | null>): Promise<boolean> {
    if (this.busy()) {
      return false;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const error = await action();
      this.error.set(error);
      return error === null;
    } finally {
      this.busy.set(false);
    }
  }

  private afterRender(callback: () => void): void {
    afterNextRender(callback, { injector: this.injector });
  }
}

/** `a`, `a and b`, `a, b and c`. */
function sentence(parts: readonly string[]): string {
  return parts.length <= 1
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) ?? ''}`;
}

function audioText(
  audio: 'keep' | 'remove' | 'replace',
  track: string | null,
  loop: boolean,
): string {
  switch (audio) {
    case 'keep':
      return 'Keep';
    case 'remove':
      return 'Remove';
    case 'replace':
      return track === null
        ? 'Replace, soundtrack not chosen'
        : `Replace with ${track}${loop ? ', looped' : ''}`;
  }
}

/** `Start 2.5 s, end 12 frames`, or `None`. */
function edgesText(start: Trim, end: Trim): string {
  const parts = [
    ...(isTrimSet(start) ? [`start ${lengthText(start)}`] : []),
    ...(isTrimSet(end) ? [`end ${lengthText(end)}`] : []),
  ].join(', ');
  return parts === '' ? 'None' : `${parts.charAt(0).toUpperCase()}${parts.slice(1)}`;
}

function lengthText(length: Trim): string {
  if (length.unit === 'seconds') {
    return `${formatTime(length.amount)} s`;
  }
  return length.amount === 1 ? '1 frame' : `${String(length.amount)} frames`;
}
