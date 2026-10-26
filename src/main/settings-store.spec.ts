import type { Recipe, Settings } from '@shared/model';
import { DEFAULT_RECIPE, DEFAULT_SETTINGS } from '@shared/model';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseSettingsFile,
  sanitizeOutput,
  sanitizeRecipe,
  sanitizeSettings,
  sanitizeTracks,
  SETTINGS_FILE,
  SettingsStore,
} from './settings-store';

const renames = vi.hoisted((): [string, string][] => []);
/** Error codes the next reads of `settings.json` fail with, one per attempt. */
const readErrors = vi.hoisted((): string[] => []);
/** Error codes the next renames of `settings.json` (setting it aside) fail with, one per attempt. */
const asideErrors = vi.hoisted((): string[] => []);

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  const failure = (code: string): Error =>
    Object.assign(new Error(`${code}: held by another program`), { code });
  return {
    ...actual,
    readFile: (file: string, encoding: BufferEncoding) => {
      const code = file.endsWith('settings.json') ? readErrors.shift() : undefined;
      return code === undefined ? actual.readFile(file, encoding) : Promise.reject(failure(code));
    },
    rename: (from: string, to: string) => {
      renames.push([from, to]);
      const code = from.endsWith('settings.json') ? asideErrors.shift() : undefined;
      return code === undefined ? actual.rename(from, to) : Promise.reject(failure(code));
    },
  };
});

/** As many failures as the store tries before giving up. */
const always = (code: string): string[] => Array<string>(5).fill(code);

const absolute = (...segments: string[]): string => path.resolve('/music', ...segments);

const RECIPE: Recipe = {
  audio: 'replace',
  trackId: 'song',
  loop: false,
  trimStart: { amount: 1.5, unit: 'seconds' },
  trimEnd: { amount: 12, unit: 'frames' },
  precision: 'fast',
};

describe('sanitizeRecipe', () => {
  it('keeps a valid recipe as it is', () => {
    expect(sanitizeRecipe(RECIPE)).toEqual(RECIPE);
  });

  it('puts back the default of each field that is not valid', () => {
    expect(
      sanitizeRecipe({
        audio: 'louder',
        trackId: '',
        loop: 'yes',
        trimStart: { amount: -2, unit: 'seconds' },
        trimEnd: { amount: 2.5, unit: 'frames' },
        precision: 7,
        extra: true,
      }),
    ).toEqual({
      ...DEFAULT_RECIPE,
      trimStart: { amount: 0, unit: 'seconds' },
      trimEnd: { amount: 0, unit: 'frames' },
    });
    expect(
      sanitizeRecipe({ ...RECIPE, trimStart: { amount: 3, unit: 'minutes' } }).trimStart,
    ).toEqual(DEFAULT_RECIPE.trimStart);
    expect(
      sanitizeRecipe({ ...RECIPE, trimEnd: { amount: '3', unit: 'seconds' } }).trimEnd,
    ).toEqual({
      amount: 0,
      unit: 'seconds',
    });
    expect(sanitizeRecipe(null)).toEqual(DEFAULT_RECIPE);
    expect(sanitizeRecipe([RECIPE])).toEqual(DEFAULT_RECIPE);
  });
});

describe('sanitizeOutput', () => {
  it('keeps an absolute folder, whatever the location', () => {
    const folder = path.resolve('/Vidéos/Sorties');
    expect(sanitizeOutput({ location: 'folder', folder })).toEqual({ location: 'folder', folder });
    expect(sanitizeOutput({ location: 'beside', folder })).toEqual({ location: 'beside', folder });
    expect(sanitizeOutput({ location: 'cloud', folder: 'relative' })).toEqual(
      DEFAULT_SETTINGS.output,
    );
  });
});

describe('sanitizeSettings', () => {
  it('forgets a track that is not in the audio list', () => {
    expect(sanitizeSettings({ recipe: RECIPE }, new Set(['song'])).recipe.trackId).toBe('song');
    expect(sanitizeSettings({ recipe: RECIPE }, new Set(['other'])).recipe.trackId).toBeNull();
    expect(sanitizeSettings('nonsense', new Set())).toEqual(DEFAULT_SETTINGS);
  });
});

describe('sanitizeTracks', () => {
  it('keeps the valid entries, the first of duplicates', () => {
    const song = absolute('Été', 'song.mp3');
    expect(
      sanitizeTracks([
        { id: 'a', path: song },
        { id: 'b', path: song },
        { id: 'a', path: absolute('other.wav') },
        { id: 'c', path: 'relative.mp3' },
        { id: 'd', path: absolute('picture.jpg') },
        { id: '', path: absolute('nameless.mp3') },
        { id: 'e', path: absolute('Loop.FLAC'), name: 'ignored', suffix: 'Boucle' },
        'nonsense',
      ]),
    ).toEqual([
      { id: 'a', path: song, suffix: 'song' },
      { id: 'e', path: absolute('Loop.FLAC'), suffix: 'Boucle' },
    ]);
    expect(sanitizeTracks({ id: 'a' })).toEqual([]);
  });

  it('cleans up the suffixes; one missing, empty or invalid is the file name', () => {
    const song = absolute('Été', 'Beach waves.mp3');
    expect(
      sanitizeTracks([
        { id: 'a', path: song },
        { id: 'b', path: absolute('b.mp3'), suffix: '' },
        { id: 'c', path: absolute('c.mp3'), suffix: 42 },
        { id: 'd', path: absolute('d.mp3'), suffix: ' AC/DC:  live ' },
      ]).map((track) => track.suffix),
    ).toEqual(['Beach waves', 'b', 'c', 'AC DC live']);
  });
});

describe('parseSettingsFile', () => {
  it('reads version 1, even after a byte order mark', () => {
    const tracks = [{ id: 'song', path: absolute('song.mp3'), suffix: 'Chanson' }];
    const text = JSON.stringify({ version: 1, settings: { recipe: RECIPE }, tracks });
    expect(parseSettingsFile(`\uFEFF${text}`)).toEqual({
      settings: { recipe: RECIPE, output: DEFAULT_SETTINGS.output },
      tracks,
    });
  });

  it('names the tracks saved without a suffix after their file', () => {
    const tracks = [{ id: 'song', path: absolute('song.mp3') }];
    const text = JSON.stringify({ version: 1, settings: { recipe: RECIPE }, tracks });
    expect(parseSettingsFile(text)?.tracks).toEqual([
      { id: 'song', path: absolute('song.mp3'), suffix: 'song' },
    ]);
  });

  it('refuses what is not JSON, not an object, or of another version', () => {
    expect(parseSettingsFile('{"version": 1,')).toBeNull();
    expect(parseSettingsFile('[]')).toBeNull();
    expect(parseSettingsFile('{"version": 2, "settings": {}}')).toBeNull();
    expect(parseSettingsFile('{"settings": {}}')).toBeNull();
  });
});

describe('SettingsStore', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'video-tool-settings-'));
  let dataDir: string;
  let counter = 0;

  beforeEach(() => {
    dataDir = path.join(root, `profile ${++counter} é`);
    renames.length = 0;
    readErrors.length = 0;
    asideErrors.length = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const settingsFile = (): string => path.join(dataDir, SETTINGS_FILE);
  const saved = (): unknown => JSON.parse(readFileSync(settingsFile(), 'utf8'));
  /** The renames of this test's folder. */
  /** One entry per temporary file: a rename retried on Windows (EPERM) is still one write. */
  const writes = (): [string, string][] => [
    ...new Map(
      renames.filter(([, to]) => to === settingsFile()).map((write) => [write[0], write]),
    ).values(),
  ];

  it('starts with the defaults, and writes nothing until something changes', async () => {
    const store = await SettingsStore.load(dataDir);
    expect(store.settings()).toEqual(DEFAULT_SETTINGS);
    expect(store.tracks()).toEqual([]);
    await store.flush();
    expect(writes()).toEqual([]);
  });

  it('saves changes, and loads them back', async () => {
    const store = await SettingsStore.load(dataDir);
    const tracks = [{ id: 'song', path: absolute('Été', 'song.mp3'), suffix: 'Plage 🌊' }];
    store.setTracks(tracks);
    const output: Settings['output'] = { location: 'folder', folder: path.resolve('/Sorties') };
    expect(store.update({ recipe: RECIPE })).toEqual({ ...DEFAULT_SETTINGS, recipe: RECIPE });
    // The recipe is kept when only the output changes.
    expect(store.update({ output })).toEqual({ recipe: RECIPE, output });
    await store.flush();

    expect(saved()).toEqual({ version: 1, settings: { recipe: RECIPE, output }, tracks });
    const reloaded = await SettingsStore.load(dataDir);
    expect(reloaded.settings()).toEqual({ recipe: RECIPE, output });
    expect(reloaded.tracks()).toEqual(tracks);
  });

  it('sanitizes updates: invalid lengths become 0, an unknown track is forgotten', async () => {
    const store = await SettingsStore.load(dataDir);
    const recipe = { ...RECIPE, trimStart: { amount: Number.NaN, unit: 'seconds' as const } };
    expect(store.update({ recipe })).toEqual({
      ...DEFAULT_SETTINGS,
      recipe: { ...RECIPE, trackId: null, trimStart: { amount: 0, unit: 'seconds' } },
    });
    await store.flush();
  });

  it('forgets the recipe track when it leaves the audio list', async () => {
    const store = await SettingsStore.load(dataDir);
    store.setTracks([{ id: 'song', path: absolute('song.mp3'), suffix: 'song' }]);
    store.update({ recipe: RECIPE });
    store.setTracks([]);
    expect(store.settings().recipe.trackId).toBeNull();
    await store.flush();
  });

  it('writes through a temporary file in the same folder, once per burst, one write at a time', async () => {
    const store = await SettingsStore.load(dataDir);
    for (let amount = 1; amount <= 20; amount++) {
      store.update({
        recipe: { ...RECIPE, trackId: null, trimStart: { amount, unit: 'seconds' } },
      });
    }
    await store.flush();
    expect(writes()).toHaveLength(1);
    const [from, to] = writes()[0]!;
    expect(path.dirname(from)).toBe(dataDir);
    expect(to).toBe(settingsFile());

    // Changes made during a write make one more write, after it.
    store.update({ recipe: { ...RECIPE, trackId: null, trimEnd: { amount: 1, unit: 'frames' } } });
    await Promise.resolve();
    store.update({ recipe: { ...RECIPE, trackId: null, trimEnd: { amount: 2, unit: 'frames' } } });
    store.update({ recipe: { ...RECIPE, trackId: null, trimEnd: { amount: 3, unit: 'frames' } } });
    await store.flush();
    expect(writes()).toHaveLength(3);
    expect(saved()).toMatchObject({ settings: { recipe: { trimEnd: { amount: 3 } } } });
    expect(readdirSync(dataDir)).toEqual([SETTINGS_FILE]);
  });

  it('sets a corrupt file aside, then starts over with the defaults', async () => {
    const store = await SettingsStore.load(dataDir);
    store.update({ output: { location: 'folder', folder: null } });
    await store.flush();
    writeFileSync(settingsFile(), '{"version": 1, "settings": ');

    const reloaded = await SettingsStore.load(dataDir);
    expect(reloaded.settings()).toEqual(DEFAULT_SETTINGS);
    const [aside, ...others] = readdirSync(dataDir);
    expect(others).toEqual([]);
    expect(aside).toMatch(/^settings\.json\.corrupt-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/);
    expect(readFileSync(path.join(dataDir, aside!), 'utf8')).toBe('{"version": 1, "settings": ');
  });

  describe('when settings.json cannot be read', () => {
    const output: Settings['output'] = { location: 'folder', folder: path.resolve('/Sorties') };
    const recipe: Recipe = { ...RECIPE, trackId: null };
    const ORIGINAL = JSON.stringify({ version: 1, settings: { recipe }, tracks: [] });
    const asideFiles = (): string[] =>
      readdirSync(dataDir).filter((name) => name !== SETTINGS_FILE);

    beforeEach(() => {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(settingsFile(), ORIGINAL);
    });

    it('tries again while another program holds it for a moment', async () => {
      readErrors.push('EBUSY', 'EPERM', 'EACCES');
      const store = await SettingsStore.load(dataDir);
      expect(readErrors).toEqual([]);
      expect(store.settings().recipe).toEqual(recipe);
    });

    it('sets it aside, then starts over with the defaults', async () => {
      readErrors.push(...always('EPERM'));
      const store = await SettingsStore.load(dataDir);
      expect(store.settings()).toEqual(DEFAULT_SETTINGS);
      const [aside, ...others] = readdirSync(dataDir);
      expect(others).toEqual([]);
      expect(aside).toMatch(/^settings\.json\.unreadable-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/);

      store.update({ output });
      await store.flush();
      expect(readFileSync(path.join(dataDir, aside!), 'utf8')).toBe(ORIGINAL);
      expect(saved()).toMatchObject({ settings: { output } });
    });

    it('never writes over it while it cannot be set aside either', async () => {
      readErrors.push(...always('EBUSY'));
      // At launch, then at the first save.
      asideErrors.push(...always('EBUSY'), ...always('EBUSY'));
      const store = await SettingsStore.load(dataDir);
      expect(store.settings()).toEqual(DEFAULT_SETTINGS);
      store.update({ output });
      store.flushSync();
      await store.flush();
      expect(asideErrors).toEqual([]);
      expect(readdirSync(dataDir)).toEqual([SETTINGS_FILE]);
      expect(readFileSync(settingsFile(), 'utf8')).toBe(ORIGINAL);

      // Once the other program lets go, the next save sets the file aside first.
      store.update({ recipe });
      await store.flush();
      const [aside, ...others] = asideFiles();
      expect(others).toEqual([]);
      expect(aside).toMatch(/^settings\.json\.unreadable-/);
      expect(readFileSync(path.join(dataDir, aside!), 'utf8')).toBe(ORIGINAL);
      expect(saved()).toMatchObject({ settings: { recipe, output } });
    });

    it('never writes over a corrupt file that cannot be set aside', async () => {
      writeFileSync(settingsFile(), '{"version": 1, "settings": ');
      asideErrors.push(...always('EPERM'), ...always('EPERM'));
      const store = await SettingsStore.load(dataDir);
      store.update({ output });
      await store.flush();
      expect(readFileSync(settingsFile(), 'utf8')).toBe('{"version": 1, "settings": ');
      // Tried at launch, then again at the save.
      expect(asideErrors).toEqual([]);
    });
  });

  it('writes the last changes before returning, when the process is about to end', async () => {
    const store = await SettingsStore.load(dataDir);
    const output: Settings['output'] = { location: 'folder', folder: path.resolve('/Sorties') };
    store.update({ output });
    store.flushSync();
    expect(saved()).toMatchObject({ settings: { output } });

    // The write that was on its way follows, and changes nothing.
    await store.flush();
    expect(saved()).toMatchObject({ settings: { output } });
    expect(readdirSync(dataDir)).toEqual([SETTINGS_FILE]);
  });

  it('logs a failed write without throwing, and keeps the change in memory', async () => {
    // The data folder cannot be created where a file stands.
    writeFileSync(path.join(root, 'blocked'), '');
    dataDir = path.join(root, 'blocked', 'profile');
    const store = await SettingsStore.load(dataDir);
    store.update({ recipe: { ...RECIPE, trackId: null } });
    await expect(store.flush()).resolves.toBeUndefined();
    expect(store.settings().recipe.precision).toBe('fast');
  });
});
