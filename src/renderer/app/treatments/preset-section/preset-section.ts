import type { ElementRef } from '@angular/core';
import {
  afterNextRender,
  Component,
  computed,
  inject,
  Injector,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import type { Preset, PresetSection as Section, Trim } from '@shared/model';
import { PRESET_SECTIONS } from '@shared/model';
import { presetSections } from '@shared/preset';
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

/** A message of a form; a new one each time, so that a repeated message is announced again. */
interface Failure {
  readonly text: string;
}

/**
 * Presets: apply one, save the treatments as a new one or as the new values of the current one,
 * rename or delete it. Each preset is a button: applying one takes a click, never a move through a
 * menu. Saving, renaming and deleting take the place of the buttons until done.
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
  private readonly presetButtons = viewChildren<ElementRef<HTMLButtonElement>>('presetButton');
  private readonly saveButton = viewChild<ElementRef<HTMLButtonElement>>('saveButton');
  private readonly renameButton = viewChild<ElementRef<HTMLButtonElement>>('renameButton');
  private readonly deleteButton = viewChild<ElementRef<HTMLButtonElement>>('deleteButton');
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');
  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>('cancelButton');

  protected readonly sections = PRESET_SECTIONS;
  protected readonly labels = LABELS;
  protected readonly presets = this.store.presets;
  protected readonly current = this.store.current;
  protected readonly modified = this.store.modified;
  protected readonly soundtrackMissing = this.store.soundtrackMissing;
  protected readonly mode = signal<Mode>('browse');
  protected readonly name = signal('');
  protected readonly chosen = signal<ReadonlySet<Section>>(new Set());
  protected readonly failure = signal<Failure | null>(null);
  /** For `@for`, which makes a new message element for each new failure. */
  protected readonly failures = computed(() => {
    const failure = this.failure();
    return failure === null ? [] : [failure];
  });
  protected readonly busy = signal(false);

  /** What the current preset sets, and whether the treatments changed since it was applied. */
  protected readonly summary = computed(() => {
    const preset = this.current();
    if (preset === null) {
      return 'Choose one to set the treatments it holds.';
    }
    const sections = sentence(presetSections(preset).map((section) => NAMES[section]));
    const sets = `${preset.name} sets ${sections}.`;
    return this.modified() ? `${sets} Changed since it was applied.` : sets;
  });

  /** Applies a preset, or the current one again, setting back what changed since. */
  protected apply(preset: Preset): void {
    this.failure.set(null);
    this.store.apply(preset);
    // Apply again goes away with the change.
    this.focusCurrent();
  }

  protected async update(preset: Preset): Promise<void> {
    if (await this.run(() => this.store.update(preset))) {
      // Update goes away with the change.
      this.focusCurrent();
    }
  }

  /**
   * The sections ticked are those of the current preset, and those the treatments make use of:
   * the audio when removed or replaced, the silences and the trims when set. Not where to save,
   * which the other sections do not change.
   */
  protected startSave(): void {
    const recipe = this.settings.recipe();
    this.name.set('');
    this.chosen.set(
      new Set<Section>([
        ...presetSections(this.current() ?? {}),
        ...(recipe.audio === 'keep' ? [] : (['audio'] as const)),
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
        await this.finish(() => this.store.create(this.name(), sections));
        break;
      }
      case 'rename':
        if (preset !== null) {
          await this.finish(() => this.store.rename(preset, this.name()));
        }
        break;
      case 'delete':
        if (preset !== null) {
          await this.finish(() => this.store.remove(preset));
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
    this.failure.set(null);
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
    this.failure.set(null);
    this.mode.set(mode);
    // Cancel is the safe default for deleting.
    this.afterRender(() =>
      (mode === 'delete' ? this.cancelButton() : this.nameInput())?.nativeElement.focus(),
    );
  }

  /**
   * Runs the action of a form; once done, the form closes, and the focus goes to the current
   * preset, or to Save as preset… when there is none left.
   */
  private async finish(action: () => Promise<string | null>): Promise<void> {
    if (await this.run(action)) {
      this.mode.set('browse');
      this.focusCurrent();
    }
  }

  /** Runs one action at a time; resolves to whether it succeeded, saying why not otherwise. */
  private async run(action: () => Promise<string | null>): Promise<boolean> {
    if (this.busy()) {
      return false;
    }
    this.busy.set(true);
    this.failure.set(null);
    try {
      const error = await action();
      this.failure.set(error === null ? null : { text: error });
      return error === null;
    } finally {
      this.busy.set(false);
    }
  }

  private focusCurrent(): void {
    this.afterRender(() => {
      const id = this.current()?.id;
      const button = this.presetButtons().find(
        ({ nativeElement }) => nativeElement.dataset['presetId'] === id,
      );
      (button ?? this.saveButton())?.nativeElement.focus();
    });
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
