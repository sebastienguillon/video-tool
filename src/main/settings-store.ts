import { createLogger } from '@shared/log';
import type {
  AudioMode,
  CutPrecision,
  OutputLocation,
  OutputSettings,
  Preset,
  PresetValues,
  Recipe,
  Settings,
  Trim,
  TrimUnit,
} from '@shared/model';
import { AUDIO_EXTENSIONS, DEFAULT_RECIPE, DEFAULT_SETTINGS } from '@shared/model';
import { presetKey, presetName, presetSections, presetValues } from '@shared/preset';
import { trackSuffix } from '@shared/track-suffix';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { extensionOf, pathKey } from './video-files';

const log = createLogger('settings');

export const SETTINGS_FILE = 'settings.json';
const FORMAT_VERSION = 1;

/** An audio list entry as saved; its name, duration and status are found again at launch. */
export interface SavedTrack {
  readonly id: string;
  readonly path: string;
  /** See `AudioTrack.suffix`. */
  readonly suffix: string;
}

/** Contents of `settings.json`, once read and sanitized. */
export interface SettingsData {
  readonly settings: Settings;
  readonly tracks: readonly SavedTrack[];
  readonly presets: readonly Preset[];
}

// Records keyed by every member of a union: adding a member to the model fails to compile here.
const AUDIO_MODES: Readonly<Record<AudioMode, true>> = { keep: true, remove: true, replace: true };
const TRIM_UNITS: Readonly<Record<TrimUnit, true>> = { seconds: true, frames: true };
const CUT_PRECISIONS: Readonly<Record<CutPrecision, true>> = { exact: true, fast: true };
const OUTPUT_LOCATIONS: Readonly<Record<OutputLocation, true>> = { beside: true, folder: true };

const memberOf =
  <T extends string>(members: Readonly<Record<T, true>>) =>
  (value: unknown): value is T =>
    typeof value === 'string' && Object.hasOwn(members, value);

export const isAudioMode = memberOf(AUDIO_MODES);
export const isTrimUnit = memberOf(TRIM_UNITS);
export const isCutPrecision = memberOf(CUT_PRECISIONS);
export const isOutputLocation = memberOf(OUTPUT_LOCATIONS);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The properties of `value`, none when it is not a plain object: ready to destructure. */
function fields(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

/**
 * A length to trim or to silence: a finite, non-negative amount, and a whole number of frames. Else
 * none.
 */
export function sanitizeTrim(value: unknown): Trim {
  const { amount, unit } = fields(value);
  if (!isTrimUnit(unit)) {
    // The amount means nothing without its unit.
    return DEFAULT_RECIPE.trimStart;
  }
  const valid =
    typeof amount === 'number' &&
    Number.isFinite(amount) &&
    amount >= 0 &&
    (unit === 'seconds' || Number.isSafeInteger(amount));
  return { amount: valid ? amount : 0, unit };
}

/** Field by field: what is not valid takes its default value. */
export function sanitizeRecipe(value: unknown): Recipe {
  const { audio, trackId, loop, trimStart, trimEnd, silenceStart, silenceEnd, precision } =
    fields(value);
  return {
    audio: isAudioMode(audio) ? audio : DEFAULT_RECIPE.audio,
    trackId: typeof trackId === 'string' && trackId !== '' ? trackId : null,
    loop: typeof loop === 'boolean' ? loop : DEFAULT_RECIPE.loop,
    trimStart: sanitizeTrim(trimStart),
    trimEnd: sanitizeTrim(trimEnd),
    // Missing from the settings of earlier versions.
    silenceStart: sanitizeTrim(silenceStart),
    silenceEnd: sanitizeTrim(silenceEnd),
    precision: isCutPrecision(precision) ? precision : DEFAULT_RECIPE.precision,
  };
}

/**
 * The folder is kept when the outputs go beside the sources, so that it is still there when the
 * user switches back.
 */
export function sanitizeOutput(value: unknown): OutputSettings {
  const { location, folder } = fields(value);
  return {
    location: isOutputLocation(location) ? location : DEFAULT_SETTINGS.output.location,
    folder: typeof folder === 'string' && path.isAbsolute(folder) ? folder : null,
  };
}

/**
 * The recipe's track must be one of `trackIds`, else it is `null`; so must the preset applied last
 * be one of `presetIds`.
 */
export function sanitizeSettings(
  value: unknown,
  trackIds: ReadonlySet<string>,
  presetIds: ReadonlySet<string> = new Set(),
): Settings {
  const { recipe, output, presetId } = fields(value);
  const clean = sanitizeRecipe(recipe);
  return {
    recipe:
      clean.trackId !== null && !trackIds.has(clean.trackId) ? { ...clean, trackId: null } : clean,
    output: sanitizeOutput(output),
    presetId: typeof presetId === 'string' && presetIds.has(presetId) ? presetId : null,
  };
}

/**
 * What a preset holds of each section it sets, field by field as for the settings: a section that
 * is not an object is left out. Its soundtrack may have left the audio list: it is kept, and the
 * preset then needs another one to replace the audio.
 */
export function sanitizePresetValues(value: unknown): PresetValues {
  const { audio, silence, trim, output } = fields(value);
  const recipe = sanitizeRecipe({ ...fields(audio), ...fields(silence), ...fields(trim) });
  const sections = (
    [
      ['audio', audio],
      ['silence', silence],
      ['trim', trim],
      ['output', output],
    ] as const
  ).flatMap(([section, values]) => (isRecord(values) ? [section] : []));
  return presetValues(recipe, sanitizeOutput(output), sections);
}

/**
 * Valid presets only: an id, a name left once cleaned up, and at least one section. The first of
 * presets with the same id or name wins.
 */
export function sanitizePresets(value: unknown): Preset[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  const presets: Preset[] = [];
  for (const entry of value as unknown[]) {
    const { id, name } = fields(entry);
    if (typeof id !== 'string' || id === '' || typeof name !== 'string') {
      continue;
    }
    const values = sanitizePresetValues(entry);
    const key = presetKey(name);
    if (key !== '' && presetSections(values).length > 0 && !ids.has(id) && !keys.has(key)) {
      ids.add(id);
      keys.add(key);
      presets.push({ id, name: presetName(name), ...values });
    }
  }
  return presets;
}

/**
 * Valid entries only: an id, an absolute path to an audio file; the first of duplicates wins. A
 * missing or invalid suffix is the file's name (see `trackSuffix`).
 */
export function sanitizeTracks(value: unknown): SavedTrack[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  const tracks: SavedTrack[] = [];
  for (const entry of value as unknown[]) {
    const { id, path: file, suffix } = fields(entry);
    if (
      typeof id !== 'string' ||
      id === '' ||
      typeof file !== 'string' ||
      !path.isAbsolute(file) ||
      !AUDIO_EXTENSIONS.includes(extensionOf(file))
    ) {
      continue;
    }
    const key = pathKey(file);
    if (!ids.has(id) && !keys.has(key)) {
      ids.add(id);
      keys.add(key);
      tracks.push({ id, path: file, suffix: trackSuffix(suffix, path.basename(file)) });
    }
  }
  return tracks;
}

/**
 * Reads the contents of `settings.json`; `null` when it is not JSON, not an object, or of another
 * format version. Invalid fields within take their default values.
 */
export function parseSettingsFile(text: string): SettingsData | null {
  let data: unknown;
  try {
    // A BOM, as some editors write, is not JSON.
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (!isRecord(data) || data['version'] !== FORMAT_VERSION) {
    return null;
  }
  const tracks = sanitizeTracks(data['tracks']);
  // Missing from the settings of earlier versions.
  const presets = sanitizePresets(data['presets']);
  return {
    settings: sanitizeSettings(
      data['settings'],
      new Set(tracks.map((track) => track.id)),
      new Set(presets.map((preset) => preset.id)),
    ),
    tracks,
    presets,
  };
}

const EMPTY: SettingsData = { settings: DEFAULT_SETTINGS, tracks: [], presets: [] };

/** Why `settings.json` was not loaded; it is set aside as `settings.json.<reason>-<date>`. */
type Unread = 'corrupt' | 'unreadable';

/**
 * The settings, the audio list and the presets, in `<data folder>/settings.json`. Changes apply at once in
 * memory; saving follows, one write at a time, a burst of changes making a single write. A write
 * goes to a temporary file renamed over the previous one, so a crash never leaves half a file.
 */
export class SettingsStore {
  private readonly file: string;
  private current: Settings;
  private savedTracks: readonly SavedTrack[];
  private savedPresets: readonly Preset[];
  /**
   * Set while `settings.json` still holds what could not be loaded: it must be renamed before the
   * next write, which never goes over it.
   */
  private unread: Unread | null;
  private dirty = false;
  private writing: Promise<void> | null = null;

  private constructor(file: string, data: SettingsData, unread: Unread | null = null) {
    this.file = file;
    this.current = data.settings;
    this.savedTracks = data.tracks;
    this.savedPresets = data.presets;
    this.unread = unread;
  }

  /**
   * Missing file: defaults. A file that cannot be read (tried a few times: an antivirus or a backup
   * tool may hold it for a moment) or understood is renamed `settings.json.unreadable-…` or
   * `settings.json.corrupt-…` before starting over with the defaults, so that nothing is silently
   * lost. While it cannot be renamed, nothing is saved; each save tries again.
   */
  static async load(dataDir: string): Promise<SettingsStore> {
    const file = path.join(dataDir, SETTINGS_FILE);
    let text: string;
    try {
      text = await withRetries(() => readFile(file, 'utf8'));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return new SettingsStore(file, EMPTY);
      }
      log.error(`Cannot read ${file}:`, error);
      return SettingsStore.startOver(file, 'unreadable');
    }
    const data = parseSettingsFile(text);
    return data === null ? SettingsStore.startOver(file, 'corrupt') : new SettingsStore(file, data);
  }

  /** The defaults, once the file that could not be loaded is set aside, or could not be. */
  private static async startOver(file: string, unread: Unread): Promise<SettingsStore> {
    const store = new SettingsStore(file, EMPTY, unread);
    await store.setAside();
    return store;
  }

  settings(): Settings {
    return this.current;
  }

  tracks(): readonly SavedTrack[] {
    return this.savedTracks;
  }

  presets(): readonly Preset[] {
    return this.savedPresets;
  }

  /**
   * `recipe` and `output` are replaced as wholes, then sanitized; a `presetId` that names no preset
   * is `null`. Returns the new settings.
   */
  update(patch: Partial<Settings>): Settings {
    const next = sanitizeSettings({ ...this.current, ...patch }, this.trackIds(), this.presetIds());
    if (JSON.stringify(next) !== JSON.stringify(this.current)) {
      this.current = next;
      this.save();
    }
    return this.current;
  }

  /** Replaces the audio list. A recipe naming a track no longer listed forgets it. */
  setTracks(tracks: readonly SavedTrack[]): void {
    this.savedTracks = tracks.map(({ id, path: file, suffix }) => ({ id, path: file, suffix }));
    this.current = sanitizeSettings(this.current, this.trackIds(), this.presetIds());
    this.save();
  }

  /**
   * Replaces the presets, checked beforehand (see `withPreset`). Settings naming one no longer
   * listed as applied last forget it.
   */
  setPresets(presets: readonly Preset[]): void {
    this.savedPresets = presets;
    this.current = sanitizeSettings(this.current, this.trackIds(), this.presetIds());
    this.save();
  }

  /** Resolves once every change made so far is on disk (or failed to be written, and logged). */
  flush(): Promise<void> {
    return this.writing ?? Promise.resolve();
  }

  /**
   * Writes the changes not on disk yet before returning. Only for the end of a Windows session:
   * the app exits as soon as the event returns, so a write in progress would not finish.
   * A file still to be set aside is left as it is.
   */
  flushSync(): void {
    // Without a write on its way, everything is on disk (or failed to be written, and logged).
    if (this.writing === null || this.unread !== null) {
      return;
    }
    // The write in progress may land after this one, with older contents: one more follows it.
    this.dirty = true;
    try {
      writeAtomicallySync(this.file, this.contents());
    } catch (error) {
      log.error(`Cannot save ${this.file}:`, error);
    }
  }

  private trackIds(): Set<string> {
    return new Set(this.savedTracks.map((track) => track.id));
  }

  private presetIds(): Set<string> {
    return new Set(this.savedPresets.map((preset) => preset.id));
  }

  private contents(): string {
    const data = {
      version: FORMAT_VERSION,
      settings: this.current,
      tracks: this.savedTracks,
      presets: this.savedPresets,
    };
    return `${JSON.stringify(data, null, 2)}\n`;
  }

  private save(): void {
    this.dirty = true;
    this.writing ??= this.drain();
  }

  private async drain(): Promise<void> {
    // Changes made in the same tick are written once.
    await Promise.resolve();
    try {
      while (this.dirty) {
        this.dirty = false;
        try {
          if (await this.setAside()) {
            await writeAtomically(this.file, this.contents());
          }
        } catch (error) {
          log.error(`Cannot save ${this.file}:`, error);
        }
      }
    } finally {
      this.writing = null;
    }
  }

  /**
   * Renames the file that could not be loaded out of the way, to `settings.json.<reason>-<date>`.
   * `false` while it cannot be: nothing may be written over it.
   */
  private async setAside(): Promise<boolean> {
    if (this.unread === null) {
      return true;
    }
    const aside = `${this.file}.${this.unread}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      await withRetries(() => rename(this.file, aside));
      log.warn(`${this.file} could not be read; it was renamed ${path.basename(aside)}.`);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        log.error(`${this.file} could not be read, nor renamed; changes are not saved:`, error);
        return false;
      }
      // Gone meanwhile: nothing is left to keep.
    }
    this.unread = null;
    return true;
  }
}

/** Writes a temporary file next to `file`, flushed to the disk, then renames it over `file`. */
async function writeAtomically(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'w');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await withRetries(() => rename(temporary, file));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** `writeAtomically`, synchronous and without retries: the process is about to end. */
function writeAtomicallySync(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(temporary, 'w');
    try {
      writeFileSync(descriptor, text, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Runs `task` again, a few times, on the errors of a file held open: on Windows an antivirus, a
 * backup tool or the search indexer may keep one for a moment.
 */
async function withRetries<T>(task: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      const code = errorCode(error);
      if (attempt === 5 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        throw error;
      }
      await delay(attempt * 40);
    }
  }
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error['code'] : undefined;
}
