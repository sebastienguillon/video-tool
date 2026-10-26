import type { Recipe } from '@shared/model';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  addVideos,
  environmentOf,
  itemFilePath,
  outputIssue,
  parseClearScope,
  parseId,
  parseIds,
  parseItemFile,
  parseOutput,
  parseRecipe,
  parseSettingsPatch,
  parseStrings,
  toolsIssue,
} from './ipc';
import type { MediaTools } from './media/media-tools';
import type * as videoFiles from './video-files';
import { expandPaths } from './video-files';

vi.mock('./video-files', async (importOriginal) => {
  const actual = await importOriginal<typeof videoFiles>();
  return { ...actual, expandPaths: vi.fn(actual.expandPaths) };
});

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: {},
  dialog: {},
  ipcMain: {},
  nativeTheme: {},
  shell: {},
}));

const RECIPE: Recipe = {
  audio: 'replace',
  trackId: 'song',
  loop: true,
  trimStart: { amount: 2.5, unit: 'seconds' },
  trimEnd: { amount: 12, unit: 'frames' },
  precision: 'exact',
};

describe('environmentOf and toolsIssue', () => {
  const tools = (version: string, features: MediaTools['features']): MediaTools => ({
    ffmpeg: '/usr/bin/ffmpeg',
    ffprobe: '/usr/bin/ffprobe',
    version,
    encoders: new Set(['libx264', 'aac']),
    decodable: new Set(['h264', 'aac']),
    features,
  });
  const dataDir = '/home/seb/.config/Video Tool';

  it('says which ffmpeg was found, and whether it can process videos', () => {
    // Ubuntu 22.04's: the older spellings will do.
    const old = tools('4.4.2-0ubuntu0.22.04.1', { demuxTimeBase: '-1', fpsMode: '-vsync' });
    expect(environmentOf(old, '2026.10.0', dataDir)).toEqual({
      appVersion: '2026.10.0',
      ffmpeg: { path: '/usr/bin/ffmpeg', version: '4.4.2-0ubuntu0.22.04.1', supported: true },
      dataDir,
    });
    expect(toolsIssue(old)).toBeNull();
    expect(environmentOf(null, '2026.10.0', dataDir).ffmpeg).toBeNull();
    expect(toolsIssue(null)).toBeNull();
  });

  it('refuses to process anything with an ffmpeg that lacks the options exact cuts need', () => {
    // Debian 9's.
    const ancient = tools('3.2.18-0+deb9u1', { demuxTimeBase: null, fpsMode: '-vsync' });
    expect(environmentOf(ancient, '2026.10.0', dataDir).ffmpeg?.supported).toBe(false);
    expect(toolsIssue(ancient)).toBe('ffmpeg 4.4 or later is needed; this one is 3.2.18-0+deb9u1.');
  });
});

describe('parseStrings and parseIds', () => {
  it('copy arrays of strings', () => {
    const paths = ['C:\\Vidéos\\clip 1.mp4', '/home/seb/日本.mkv', ''];
    expect(parseStrings(paths, 'paths')).toEqual(paths);
    expect(parseStrings(paths, 'paths')).not.toBe(paths);
    expect(parseIds(['1', 'b9f1'])).toEqual(['1', 'b9f1']);
  });

  it('reject anything else', () => {
    for (const value of ['clip.mp4', ['clip.mp4', 3], [null], { 0: 'a' }, undefined]) {
      expect(() => parseStrings(value, 'paths')).toThrow('Invalid paths.');
    }
    expect(() =>
      parseStrings(
        Array.from({ length: 100_001 }, () => 'a'),
        'paths',
      ),
    ).toThrow();
    expect(() => parseIds(['1', ''])).toThrow('Invalid ids.');
    expect(() => parseIds(['x'.repeat(257)])).toThrow('Invalid ids.');
  });
});

describe('parseId, parseItemFile and parseClearScope', () => {
  it('accept the known values only', () => {
    expect(parseId('42')).toBe('42');
    expect(() => parseId(42)).toThrow('Invalid id.');
    expect(() => parseId('')).toThrow('Invalid id.');
    expect(parseItemFile('source')).toBe('source');
    expect(parseItemFile('output')).toBe('output');
    expect(() => parseItemFile('folder')).toThrow('Invalid file.');
    expect(parseClearScope('all')).toBe('all');
    expect(parseClearScope('finished')).toBe('finished');
    expect(() => parseClearScope('done')).toThrow('Invalid scope.');
  });
});

describe('parseRecipe', () => {
  it('rebuilds a well-formed recipe, without anything else', () => {
    const parsed = parseRecipe({
      ...RECIPE,
      extra: 'dropped',
      trimStart: { ...RECIPE.trimStart, x: 1 },
    });
    expect(parsed).toEqual(RECIPE);
    expect(Object.keys(parsed.trimStart)).toEqual(['amount', 'unit']);
    expect(parseRecipe({ ...RECIPE, audio: 'remove', trackId: null })).toMatchObject({
      trackId: null,
    });
  });

  it('leaves lengths the user got wrong for recipeIssue to explain', () => {
    const trimStart = { amount: -1, unit: 'frames' } as const;
    expect(parseRecipe({ ...RECIPE, trimStart }).trimStart).toEqual(trimStart);
    expect(
      parseRecipe({ ...RECIPE, trimEnd: { amount: Number.NaN, unit: 'seconds' } }).trimEnd.amount,
    ).toBeNaN();
  });

  it('rejects a malformed recipe', () => {
    for (const recipe of [
      null,
      [RECIPE],
      { ...RECIPE, audio: 'mute' },
      { ...RECIPE, trackId: '' },
      { ...RECIPE, trackId: 7 },
      { ...RECIPE, loop: 'yes' },
      { ...RECIPE, precision: 'rough' },
      { ...RECIPE, trimStart: 2 },
      { ...RECIPE, trimStart: { amount: '2', unit: 'seconds' } },
      { ...RECIPE, trimEnd: { amount: 2, unit: 'minutes' } },
      { ...RECIPE, trimEnd: undefined },
    ]) {
      expect(() => parseRecipe(recipe)).toThrow(/^Invalid (recipe|trim)\.$/);
    }
  });
});

describe('parseOutput and parseSettingsPatch', () => {
  const folder = path.resolve('/Vidéos/Sorties');

  it('accept a location and an absolute folder, or none', () => {
    expect(parseOutput({ location: 'folder', folder })).toEqual({ location: 'folder', folder });
    expect(parseOutput({ location: 'beside', folder: null })).toEqual({
      location: 'beside',
      folder: null,
    });
    expect(() => parseOutput({ location: 'beside', folder: 'Sorties' })).toThrow();
    expect(() => parseOutput({ location: 'desktop', folder: null })).toThrow();
    expect(() => parseOutput({ location: 'folder' })).toThrow();
  });

  it('take the parts of the settings that are given, and nothing unknown', () => {
    expect(parseSettingsPatch({})).toEqual({});
    expect(parseSettingsPatch({ recipe: RECIPE })).toEqual({ recipe: RECIPE });
    expect(parseSettingsPatch({ output: { location: 'folder', folder } })).toEqual({
      output: { location: 'folder', folder },
    });
    expect(() => parseSettingsPatch({ theme: 'dark' })).toThrow('Invalid settings.');
    expect(() => parseSettingsPatch({ recipe: {} })).toThrow('Invalid recipe.');
    expect(() => parseSettingsPatch(null)).toThrow('Invalid settings.');
  });
});

describe('with files on disk', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'video-tool-ipc-'));
  const clips = path.join(root, 'Clips é');
  mkdirSync(path.join(clips, 'more'), { recursive: true });
  const clip = (name: string): string => {
    const file = path.join(clips, name);
    writeFileSync(file, '');
    return file;
  };
  const first = clip('clip 1.mp4');
  const second = clip(path.join('more', 'clip 2.MOV'));
  const notes = clip('notes.txt');

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('addVideos', () => {
    it('adds the videos found, and counts what was ignored', async () => {
      const add = vi.fn((files: readonly string[]) => ({ added: files.length - 1, duplicates: 1 }));
      await expect(
        addVideos({ add }, [clips, notes, path.join(root, 'gone.mp4')]),
      ).resolves.toEqual({
        added: 1,
        duplicates: 1,
        ignored: 2,
        truncated: false,
      });
      expect(add).toHaveBeenCalledWith([first, second]);
    });

    it('tells when folders held more videos than one drop takes', async () => {
      vi.mocked(expandPaths).mockResolvedValueOnce({ files: [first], ignored: 0, truncated: true });
      const add = vi.fn(() => ({ added: 1, duplicates: 0 }));
      await expect(addVideos({ add }, [clips])).resolves.toEqual({
        added: 1,
        duplicates: 0,
        ignored: 0,
        truncated: true,
      });
    });

    it('leaves the queue alone when there is nothing to add', async () => {
      const add = vi.fn(() => ({ added: 0, duplicates: 0 }));
      await expect(addVideos({ add }, [notes])).resolves.toEqual({
        added: 0,
        duplicates: 0,
        ignored: 1,
        truncated: false,
      });
      expect(add).not.toHaveBeenCalled();
    });
  });

  describe('itemFilePath', () => {
    const queue = {
      sourcePath: (id: string) => ({ a: first, gone: path.join(root, 'gone.mp4') })[id] ?? null,
      outputPath: (id: string) => (id === 'a' ? second : null),
    };

    it('gives the source or the output of an item', async () => {
      await expect(itemFilePath(queue, 'a', 'source')).resolves.toBe(first);
      await expect(itemFilePath(queue, 'a', 'output')).resolves.toBe(second);
    });

    it('says why there is no file to show', async () => {
      await expect(itemFilePath(queue, 'b', 'source')).rejects.toThrow(
        'This video is no longer in the list.',
      );
      await expect(itemFilePath(queue, 'b', 'output')).rejects.toThrow(
        'This video has not been processed yet.',
      );
      await expect(itemFilePath(queue, 'gone', 'source')).rejects.toThrow(
        'gone.mp4 cannot be found: it was moved or deleted.',
      );
      await expect(itemFilePath(queue, 'a', 'thumbnail')).rejects.toThrow('Invalid file.');
    });
  });

  describe('outputIssue', () => {
    it('needs an existing folder when the videos go to one', async () => {
      await expect(outputIssue({ location: 'beside', folder: null })).resolves.toBeNull();
      await expect(outputIssue({ location: 'folder', folder: clips })).resolves.toBeNull();
      await expect(outputIssue({ location: 'folder', folder: null })).resolves.toBe(
        'Choose the folder to save the videos in.',
      );
      const gone = path.join(root, 'Unplugged drive');
      await expect(outputIssue({ location: 'folder', folder: gone })).resolves.toBe(
        `The output folder ${gone} cannot be found: choose another one.`,
      );
      await expect(outputIssue({ location: 'folder', folder: notes })).resolves.not.toBeNull();
    });
  });
});
