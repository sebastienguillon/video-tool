import type { AudioTrack } from '@shared/model';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioLibraryOptions, ProbeAudio } from './audio-library';
import { AudioLibrary } from './audio-library';
import type { SavedTrack } from './settings-store';

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('AudioLibrary', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'video-tool-audio-'));
  const music = path.join(root, 'Musique 日本');
  mkdirSync(music);
  const file = (name: string): string => {
    const target = path.join(music, name);
    writeFileSync(target, name);
    return target;
  };
  const song = file('Été.mp3');
  const loop = file('loop.WAV');
  const notAudio = file('cover.jpg');

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  let saves: (readonly SavedTrack[])[];
  let changes: (readonly AudioTrack[])[];
  let probed: string[];
  beforeEach(() => {
    saves = [];
    changes = [];
    probed = [];
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  /** Durations by file name; a name without one cannot be read. */
  const probeOf =
    (durations: Readonly<Record<string, number>>): ProbeAudio =>
    async (target) => {
      probed.push(path.basename(target));
      await nextTick();
      const durationSec = durations[path.basename(target)];
      if (durationSec === undefined) {
        throw new Error('Not an audio file.');
      }
      return { durationSec };
    };

  const create = (options: Partial<AudioLibraryOptions> = {}): AudioLibrary =>
    new AudioLibrary({
      saved: [],
      save: (tracks) => saves.push(tracks),
      probe: probeOf({ 'Été.mp3': 61.5, 'loop.WAV': 4 }),
      onChange: (tracks) => changes.push(tracks),
      ...options,
    });

  const settle = (library: AudioLibrary): Promise<void> => library.refresh().then(nextTick);

  it('adds existing audio files only, as probing, then with their duration', async () => {
    const library = create();
    const result = await library.add([song, loop, notAudio, music, path.join(music, 'gone.mp3')]);
    expect(result).toEqual({ added: 2, duplicates: 0, ignored: 3, truncated: false });
    expect(library.list().map((track) => [track.name, track.suffix, track.status])).toEqual([
      ['Été.mp3', 'Été', 'probing'],
      ['loop.WAV', 'loop', 'probing'],
    ]);
    expect(saves.at(-1)).toEqual(
      library.list().map(({ id, path: target, suffix }) => ({ id, path: target, suffix })),
    );

    await settle(library);
    expect(
      library.list().map(({ name, status, durationSec }) => [name, status, durationSec]),
    ).toEqual([
      ['Été.mp3', 'ok', 61.5],
      ['loop.WAV', 'ok', 4],
    ]);
    expect(changes.at(-1)).toBe(library.list());
  });

  it('counts files already listed as duplicates', async () => {
    const library = create();
    await library.add([song]);
    const again = caseInsensitive ? [song, song.toUpperCase()] : [song];
    expect(await library.add(again)).toEqual({
      added: 0,
      duplicates: 1,
      ignored: 0,
      truncated: false,
    });
    expect(library.list()).toHaveLength(1);
  });

  it('marks a file that cannot be probed as unreadable', async () => {
    const library = create({ probe: probeOf({}) });
    await library.add([song]);
    await settle(library);
    expect(library.list()[0]).toMatchObject({ status: 'unreadable', durationSec: null });
  });

  it('without ffprobe, lists the files as ok, of unknown duration', async () => {
    const library = create({ probe: null });
    await library.add([song]);
    await settle(library);
    expect(library.list()[0]).toMatchObject({ status: 'ok', durationSec: null });
  });

  it('keeps a missing track listed, and probes it again once it is back', async () => {
    const moved = path.join(root, 'moved.mp3');
    const library = create({ saved: [{ id: 'kept', path: song, suffix: 'Été' }] });
    await settle(library);
    expect(library.track('kept')).toMatchObject({ status: 'ok', durationSec: 61.5 });

    renameSync(song, moved);
    try {
      await settle(library);
      expect(library.track('kept')).toMatchObject({ status: 'missing', durationSec: null });
      expect(library.resolve('kept')).toBe(song);
    } finally {
      renameSync(moved, song);
    }
    await settle(library);
    expect(library.track('kept')).toMatchObject({ status: 'ok', durationSec: 61.5 });
    expect(probed).toEqual(['Été.mp3', 'Été.mp3']);
  });

  it('probes a file again only when it changed', async () => {
    const changing = file('changing.mp3');
    const library = create({
      saved: [{ id: 'changing', path: changing, suffix: 'changing' }],
      probe: probeOf({ 'changing.mp3': 10 }),
    });
    await settle(library);
    await settle(library);
    expect(probed).toEqual(['changing.mp3']);

    writeFileSync(changing, 'a longer version');
    await settle(library);
    expect(probed).toEqual(['changing.mp3', 'changing.mp3']);
  });

  it('probes one file at a time', async () => {
    let running = 0;
    let peak = 0;
    const library = create({
      probe: async () => {
        running++;
        peak = Math.max(peak, running);
        await nextTick();
        running--;
        return { durationSec: 1 };
      },
    });
    await library.add([song, loop]);
    await settle(library);
    expect(peak).toBe(1);
  });

  it('forgets a removed track, and does not bring it back when its probe ends', async () => {
    const library = create();
    await library.add([song, loop]);
    const [first, second] = library.list();
    library.remove(first!.id);
    await settle(library);
    expect(library.list().map((track) => track.id)).toEqual([second!.id]);
    expect(library.resolve(first!.id)).toBeNull();
    expect(await library.check(first!.id)).toBeNull();
    expect(saves.at(-1)).toEqual([{ id: second!.id, path: loop, suffix: 'loop' }]);
  });

  it('keeps the suffix saved, and saves the one chosen, cleaned up', async () => {
    const library = create({ saved: [{ id: 'kept', path: song, suffix: 'Plage' }] });
    expect(library.track('kept')?.suffix).toBe('Plage');
    await settle(library);
    changes.length = 0;

    expect(library.setSuffix('kept', ' Vagues / mer ')).toBe('Vagues mer');
    expect(library.track('kept')?.suffix).toBe('Vagues mer');
    expect(saves.at(-1)).toEqual([{ id: 'kept', path: song, suffix: 'Vagues mer' }]);
    await nextTick();
    expect(changes.at(-1)?.[0]?.suffix).toBe('Vagues mer');

    // Nothing left: the file name, without its extension.
    expect(library.setSuffix('kept', ' ? ')).toBe('Été');
    expect(saves.at(-1)).toEqual([{ id: 'kept', path: song, suffix: 'Été' }]);
    await nextTick();

    // The same suffix again changes nothing.
    const saved = saves.length;
    changes.length = 0;
    expect(library.setSuffix('kept', 'Été ')).toBe('Été');
    await nextTick();
    expect(saves).toHaveLength(saved);
    expect(changes).toEqual([]);

    expect(library.setSuffix('gone', 'Plage')).toBeNull();
    expect(saves).toHaveLength(saved);
  });

  it('announces changes made in the same tick once', async () => {
    const library = create({ probe: null });
    await library.add([song, loop]);
    await settle(library);
    changes.length = 0;
    for (const track of library.list()) {
      library.remove(track.id);
    }
    await nextTick();
    expect(changes).toEqual([[]]);
  });
});
