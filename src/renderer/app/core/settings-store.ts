import { computed, DestroyRef, DOCUMENT, inject, Injectable, signal } from '@angular/core';
import { createLogger } from '@shared/log';
import type { OutputLocation, OutputSettings, Recipe, Trim } from '@shared/model';
import { DEFAULT_SETTINGS } from '@shared/model';
import { DESKTOP } from './desktop';

const log = createLogger('settings');

/** Startup never waits longer than this for stored settings. */
const LOAD_TIMEOUT_MS = 2_000;
/** Typing in a trim field changes the recipe at every keystroke: saves wait for a pause. */
const SAVE_DELAY_MS = 400;

/** A field of the recipe that holds a length typed by the user, to trim or to silence. */
export type LengthKey = 'trimStart' | 'trimEnd' | 'silenceStart' | 'silenceEnd';

/**
 * The treatments, the output location and the preset applied last, persisted by the main process
 * so that they survive a restart. The recipe is saved after a pause in changes; the others at once,
 * since processing reads the output from the main process.
 */
@Injectable({ providedIn: 'root' })
export class SettingsStore {
  private readonly desktop = inject(DESKTOP);
  private readonly currentRecipe = signal<Recipe>(DEFAULT_SETTINGS.recipe);
  private readonly currentOutput = signal<OutputSettings>(DEFAULT_SETTINGS.output);
  private readonly currentPreset = signal<string | null>(DEFAULT_SETTINGS.presetId);
  private readonly invalidLengths = signal<ReadonlySet<LengthKey>>(new Set());
  /** The recipe as the main process has it, last loaded or sent. */
  private savedRecipe = DEFAULT_SETTINGS.recipe;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  readonly recipe = this.currentRecipe.asReadonly();
  readonly output = this.currentOutput.asReadonly();
  /** The id of the preset applied last; `null`: none, or it was deleted. */
  readonly presetId = this.currentPreset.asReadonly();
  /**
   * What a field that holds text that is not a length is for: the recipe still has the last valid
   * one. Those of the silences do not count while the audio is removed, which leaves them unused.
   */
  readonly invalidLength = computed<'trim' | 'silence' | null>(() => {
    const invalid = this.invalidLengths();
    if (invalid.has('trimStart') || invalid.has('trimEnd')) {
      return 'trim';
    }
    const silencing = this.currentRecipe().audio !== 'remove';
    return silencing && (invalid.has('silenceStart') || invalid.has('silenceEnd'))
      ? 'silence'
      : null;
  });

  constructor() {
    // A change made just before the window closes is not lost.
    const view = inject(DOCUMENT).defaultView;
    const flush = (): void => {
      void this.flush();
    };
    view?.addEventListener('beforeunload', flush);
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.saveTimer);
      view?.removeEventListener('beforeunload', flush);
    });
  }

  /** Loads the stored settings; used as an app initializer so that the first render is final. */
  async load(): Promise<void> {
    const timeout = new Promise<null>((resolve) => setTimeout(resolve, LOAD_TIMEOUT_MS, null));
    const settings = await Promise.race([this.desktop.getSettings(), timeout]).catch(
      (error: unknown) => {
        log.warn('Cannot load the settings:', error);
        return null;
      },
    );
    if (settings) {
      this.savedRecipe = settings.recipe;
      this.currentRecipe.set(settings.recipe);
      this.currentOutput.set(settings.output);
      this.currentPreset.set(settings.presetId);
    }
  }

  updateRecipe(patch: Partial<Recipe>): void {
    const next: Recipe = { ...this.currentRecipe(), ...patch };
    if (sameRecipe(next, this.currentRecipe())) {
      return;
    }
    this.currentRecipe.set(next);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.flush();
    }, SAVE_DELAY_MS);
  }

  setLengthValidity(field: LengthKey, valid: boolean): void {
    const invalid = this.invalidLengths();
    if (invalid.has(field) === !valid) {
      return;
    }
    const next = new Set(invalid);
    if (valid) {
      next.delete(field);
    } else {
      next.add(field);
    }
    this.invalidLengths.set(next);
  }

  async setOutput(output: OutputSettings): Promise<void> {
    this.currentOutput.set(output);
    try {
      await this.desktop.updateSettings({ output });
    } catch (error) {
      log.warn('Cannot save the output settings:', error);
    }
  }

  async setPreset(presetId: string | null): Promise<void> {
    if (presetId === this.currentPreset()) {
      return;
    }
    this.currentPreset.set(presetId);
    try {
      await this.desktop.updateSettings({ presetId });
    } catch (error) {
      log.warn('Cannot save the preset applied:', error);
    }
  }

  /**
   * Saving in a folder needs one: when none was chosen yet, it is asked for, and the results stay
   * next to the videos if the dialog is canceled.
   */
  async setLocation(location: OutputLocation): Promise<void> {
    const current = this.currentOutput();
    if (location === current.location) {
      return;
    }
    if (location === 'beside' || current.folder !== null) {
      await this.setOutput({ ...current, location });
      return;
    }
    // Shown as chosen while the dialog is open.
    this.currentOutput.set({ location, folder: null });
    if (!(await this.chooseOutputFolder())) {
      this.currentOutput.set(current);
    }
  }

  /** Asks for the output folder, and saves in it; resolves to whether one was chosen. */
  async chooseOutputFolder(): Promise<boolean> {
    let folder: string | null = null;
    try {
      folder = await this.desktop.chooseOutputFolder();
    } catch (error) {
      log.warn('Cannot ask for the output folder:', error);
    }
    if (folder === null) {
      return false;
    }
    await this.setOutput({ location: 'folder', folder });
    return true;
  }

  /** Saves a recipe change still waiting for its pause, now. */
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    const recipe = this.currentRecipe();
    if (recipe === this.savedRecipe) {
      return;
    }
    this.savedRecipe = recipe;
    try {
      await this.desktop.updateSettings({ recipe });
    } catch (error) {
      log.warn('Cannot save the treatments:', error);
    }
  }
}

function sameTrim(a: Trim, b: Trim): boolean {
  return a.amount === b.amount && a.unit === b.unit;
}

function sameRecipe(a: Recipe, b: Recipe): boolean {
  return (
    a.audio === b.audio &&
    a.trackId === b.trackId &&
    a.loop === b.loop &&
    a.precision === b.precision &&
    sameTrim(a.trimStart, b.trimStart) &&
    sameTrim(a.trimEnd, b.trimEnd) &&
    sameTrim(a.silenceStart, b.silenceStart) &&
    sameTrim(a.silenceEnd, b.silenceEnd)
  );
}
