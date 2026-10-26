import { createLogger } from '@shared/log';
import type { AddResult, AudioTrack } from '@shared/model';
import { AUDIO_EXTENSIONS } from '@shared/model';
import { trackSuffix } from '@shared/track-suffix';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { SavedTrack } from './settings-store';
import { expandPaths, pathKey } from './video-files';

const log = createLogger('audio-library');

/** Duration of an audio file; rejects when it cannot be read as audio. */
export type ProbeAudio = (file: string) => Promise<{ readonly durationSec: number }>;

export interface AudioLibraryOptions {
  /** The saved list, in its order. */
  readonly saved: readonly SavedTrack[];
  /** Persists the whole list (ids, paths and suffixes), after each addition, removal or new suffix. */
  readonly save: (tracks: readonly SavedTrack[]) => void;
  /**
   * `null` without ffprobe. Tracks whose file exists are then `ok`, of unknown duration: nothing can
   * tell them unreadable, and the missing ffmpeg is what the user has to fix first.
   */
  readonly probe: ProbeAudio | null;
  /** Receives the whole list after changes, at most once per tick. */
  readonly onChange: (tracks: readonly AudioTrack[]) => void;
}

/**
 * The persisted list of replacement soundtracks. Folders are not accepted: a soundtrack is picked
 * one file at a time, and walking a music library would flood the list. A track whose file
 * disappears stays listed as `missing`, and comes back once the file does: `refresh` checks again.
 */
export class AudioLibrary {
  private readonly options: AudioLibraryOptions;
  private entries: readonly AudioTrack[];
  /** Size and modification time of each file when last probed: an unchanged one is not probed again. */
  private readonly stamps = new Map<string, string>();
  /** Checks in progress, by track id. */
  private readonly checks = new Map<string, Promise<void>>();
  /** Probes run one at a time: re-checking a long list at launch spawns one ffprobe at a time. */
  private probes: Promise<unknown> = Promise.resolve();
  private notifying = false;

  constructor(options: AudioLibraryOptions) {
    this.options = options;
    this.entries = options.saved.map(({ id, path: file, suffix }) => ({
      id,
      path: file,
      name: path.basename(file),
      suffix,
      durationSec: null,
      status: 'probing',
    }));
  }

  list(): readonly AudioTrack[] {
    return this.entries;
  }

  track(id: string): AudioTrack | null {
    return this.entries.find((entry) => entry.id === id) ?? null;
  }

  /** Path of a listed track: the only audio files the app reads for previews and replacements. */
  resolve(id: string): string | null {
    return this.track(id)?.path ?? null;
  }

  /**
   * Adds audio files, by extension; folders and missing files are ignored. Resolves once they are
   * listed, as `probing`: their duration follows through `onChange`.
   */
  async add(paths: readonly string[]): Promise<AddResult> {
    const { files, ignored, truncated } = await expandPaths(paths, {
      extensions: AUDIO_EXTENSIONS,
      folders: false,
    });
    const known = new Set(this.entries.map((entry) => pathKey(entry.path)));
    const added: AudioTrack[] = [];
    for (const file of files) {
      const key = pathKey(file);
      if (!known.has(key)) {
        known.add(key);
        added.push({
          id: randomUUID(),
          path: file,
          name: path.basename(file),
          suffix: trackSuffix(null, path.basename(file)),
          durationSec: null,
          status: 'probing',
        });
      }
    }
    if (added.length > 0) {
      this.entries = [...this.entries, ...added];
      this.persist();
      this.notify();
      for (const entry of added) {
        void this.check(entry.id);
      }
    }
    return { added: added.length, duplicates: files.length - added.length, ignored, truncated };
  }

  /** Forgets a track; its file is left alone. */
  remove(id: string): void {
    const next = this.entries.filter((entry) => entry.id !== id);
    if (next.length !== this.entries.length) {
      this.entries = next;
      this.stamps.delete(id);
      this.persist();
      this.notify();
    }
  }

  /**
   * Sets what the names of results say of a track (see `trackSuffix`: `text` is cleaned up, and
   * the file's name takes the place of nothing). Returns the suffix kept; `null` when the track is
   * not listed.
   */
  setSuffix(id: string, text: string): string | null {
    const index = this.entries.findIndex((entry) => entry.id === id);
    const entry = this.entries[index];
    if (entry === undefined) {
      return null;
    }
    const suffix = trackSuffix(text, entry.name);
    if (suffix !== entry.suffix) {
      this.entries = this.entries.with(index, { ...entry, suffix });
      this.persist();
      this.notify();
    }
    return suffix;
  }

  /** Checks every track again: files gone, back, or changed since they were probed. */
  async refresh(): Promise<void> {
    await Promise.all(this.entries.map((entry) => this.check(entry.id)));
  }

  /**
   * Checks the file of a track now (or waits for the check in progress), then returns the track;
   * `null` when it is not listed.
   */
  async check(id: string): Promise<AudioTrack | null> {
    let check = this.checks.get(id);
    if (check === undefined) {
      check = this.inspect(id).finally(() => this.checks.delete(id));
      this.checks.set(id, check);
    }
    await check;
    return this.track(id);
  }

  private async inspect(id: string): Promise<void> {
    const entry = this.track(id);
    if (entry === null) {
      return;
    }
    const stamp = await fileStamp(entry.path);
    if (stamp === null) {
      this.stamps.delete(id);
      this.set(id, { durationSec: null, status: 'missing' });
      return;
    }
    const { probe } = this.options;
    if (probe === null) {
      this.set(id, { durationSec: null, status: 'ok' });
      return;
    }
    if (stamp === this.stamps.get(id)) {
      return;
    }
    this.set(id, { durationSec: null, status: 'probing' });
    const durationSec = await this.runProbe(probe, entry.path).then(
      ({ durationSec: seconds }) => (Number.isFinite(seconds) && seconds > 0 ? seconds : null),
      (error: unknown) => {
        log.warn(`Cannot read ${entry.path} as audio:`, errorMessage(error));
        return null;
      },
    );
    // Removed meanwhile: nothing to update.
    if (this.track(id) !== null) {
      this.stamps.set(id, stamp);
      this.set(id, { durationSec, status: durationSec === null ? 'unreadable' : 'ok' });
    }
  }

  private runProbe(probe: ProbeAudio, file: string): Promise<{ readonly durationSec: number }> {
    const run = this.probes.then(() => probe(file));
    this.probes = run.catch(() => undefined);
    return run;
  }

  private set(id: string, changes: Pick<AudioTrack, 'durationSec' | 'status'>): void {
    const index = this.entries.findIndex((entry) => entry.id === id);
    const entry = this.entries[index];
    if (
      entry === undefined ||
      (entry.status === changes.status && entry.durationSec === changes.durationSec)
    ) {
      return;
    }
    this.entries = this.entries.with(index, { ...entry, ...changes });
    this.notify();
  }

  private persist(): void {
    this.options.save(
      this.entries.map(({ id, path: file, suffix }) => ({ id, path: file, suffix })),
    );
  }

  private notify(): void {
    if (this.notifying) {
      return;
    }
    this.notifying = true;
    queueMicrotask(() => {
      this.notifying = false;
      this.options.onChange(this.entries);
    });
  }
}

/** Size and modification time of a file; `null` when it is missing or not a file. */
async function fileStamp(file: string): Promise<string | null> {
  try {
    const stats = await stat(file);
    return stats.isFile() ? `${stats.size}:${stats.mtimeMs}` : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
