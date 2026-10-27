import { describe, expect, it } from 'vitest';
import type { OutputSettings, Preset, Recipe } from './model';
import { DEFAULT_RECIPE } from './model';
import type { Treatments } from './preset';
import {
  applyPreset,
  byName,
  presetIssue,
  presetKey,
  presetMatches,
  presetName,
  presetSections,
  presetValues,
  shortPresetName,
} from './preset';

const seconds = (amount: number) => ({ amount, unit: 'seconds' }) as const;
const frames = (amount: number) => ({ amount, unit: 'frames' }) as const;

const BESIDE: OutputSettings = { location: 'beside', folder: 'D:\\Exports' };
const IN_FOLDER: OutputSettings = { location: 'folder', folder: 'D:\\Exports' };

function treatments(patch: Partial<Recipe> = {}, output = BESIDE): Treatments {
  return { recipe: { ...DEFAULT_RECIPE, ...patch }, output };
}

const TRIM = { trimStart: seconds(0), trimEnd: frames(12), precision: 'exact' } as const;
const TIKTOK: Preset = { id: 'tiktok', name: 'TikTok', trim: TRIM };

describe('presetName, shortPresetName and presetKey', () => {
  it('cleans up a name as typed', () => {
    expect(presetName('  TikTok   end \t')).toBe('TikTok end');
    expect(presetName(' \n ')).toBe('');
    // Composed, as macOS file names are not.
    expect(presetName('e\u0301te\u0301')).toBe('été');
  });

  it('cuts names saved elsewhere to the longest kept, in characters as people count them', () => {
    expect(shortPresetName(` ${'a'.repeat(70)}`)).toBe('a'.repeat(60));
    // An emoji is not cut in half, nor a family of them.
    expect(shortPresetName(`${'a'.repeat(59)}🎬🎬`)).toBe(`${'a'.repeat(59)}🎬`);
    expect(shortPresetName(`${'a'.repeat(59)}👨‍👩‍👧x`)).toBe(`${'a'.repeat(59)}👨‍👩‍👧`);
  });

  it('tells names apart only when they look different', () => {
    expect(presetKey(' tiktok ')).toBe(presetKey('TikTok'));
    expect(presetKey('Tik  Tok')).toBe(presetKey('tik tok'));
    // Full-width letters, zero-width spaces and fillers.
    expect(presetKey('ＴｉｋＴｏｋ')).toBe(presetKey('TikTok'));
    expect(presetKey('Tik\u200bTok\u2060')).toBe(presetKey('TikTok'));
    expect(presetKey('\u200b\u3164')).toBe('');
    expect(presetKey('TikTok 2')).not.toBe(presetKey('TikTok'));
  });
});

describe('presetValues and presetSections', () => {
  const current = treatments(
    {
      audio: 'replace',
      trackId: 'beach',
      loop: false,
      silenceEnd: seconds(1),
      trimEnd: frames(12),
      precision: 'fast',
    },
    IN_FOLDER,
  );

  it('keeps the treatments of the sections chosen, in the order of the panel', () => {
    const values = presetValues(current.recipe, current.output, ['trim', 'audio']);
    expect(values).toEqual({
      audio: { audio: 'replace', trackId: 'beach', loop: false },
      trim: { trimStart: seconds(0), trimEnd: frames(12), precision: 'fast' },
    });
    expect(presetSections(values)).toEqual(['audio', 'trim']);
    expect(presetSections(presetValues(current.recipe, current.output, []))).toEqual([]);
    expect(presetValues(current.recipe, current.output, ['silence', 'output'])).toEqual({
      silence: { silenceStart: seconds(0), silenceEnd: seconds(1) },
      output: IN_FOLDER,
    });
  });

  it('keeps a soundtrack only for a replaced audio, and a folder only for saving in one', () => {
    const kept = treatments({ audio: 'keep', trackId: 'beach', loop: false });
    expect(presetValues(kept.recipe, kept.output, ['audio', 'output'])).toEqual({
      audio: { audio: 'keep', trackId: null, loop: true },
      output: { location: 'beside', folder: null },
    });
  });
});

describe('applyPreset', () => {
  it('sets the sections the preset holds, and leaves the others', () => {
    const before = treatments({ audio: 'keep', silenceStart: seconds(2), trimStart: frames(3) });
    expect(applyPreset(TIKTOK, before)).toEqual(
      treatments({ audio: 'keep', silenceStart: seconds(2), trimEnd: frames(12) }),
    );
    const everything: Preset = {
      ...TIKTOK,
      audio: { audio: 'replace', trackId: 'beach', loop: false },
      silence: { silenceStart: seconds(0), silenceEnd: frames(5) },
      output: IN_FOLDER,
    };
    expect(applyPreset(everything, before)).toEqual(
      treatments(
        {
          audio: 'replace',
          trackId: 'beach',
          loop: false,
          silenceEnd: frames(5),
          trimEnd: frames(12),
        },
        IN_FOLDER,
      ),
    );
  });

  it('keeps the folder chosen when a preset saves in a folder it does not name', () => {
    const noFolder: Preset = {
      id: 'n',
      name: 'Folder',
      output: { location: 'folder', folder: null },
    };
    expect(applyPreset(noFolder, treatments({}, BESIDE)).output).toEqual(IN_FOLDER);
    expect(presetMatches(noFolder, treatments({}, IN_FOLDER))).toBe(true);
  });

  it('leaves the soundtrack and the folder chosen for later, when the preset does not use them', () => {
    const before = treatments({ audio: 'replace', trackId: 'beach', loop: false }, IN_FOLDER);
    const keepBeside: Preset = {
      id: 'k',
      name: 'Keep',
      audio: { audio: 'keep', trackId: null, loop: true },
      output: { location: 'beside', folder: null },
    };
    expect(applyPreset(keepBeside, before)).toEqual(
      treatments({ audio: 'keep', trackId: 'beach', loop: false }, BESIDE),
    );
  });
});

describe('presetMatches', () => {
  it('tells whether the treatments changed in what the preset sets', () => {
    expect(presetMatches(TIKTOK, applyPreset(TIKTOK, treatments()))).toBe(true);
    expect(presetMatches(TIKTOK, treatments({ trimEnd: frames(13) }))).toBe(false);
    expect(presetMatches(TIKTOK, treatments({ trimEnd: seconds(12) }))).toBe(false);
    expect(presetMatches(TIKTOK, treatments({ trimEnd: frames(12), precision: 'fast' }))).toBe(
      false,
    );
    // Nor do the silences of an audio removed.
    const removed: Preset = {
      id: 'r',
      name: 'Silent',
      audio: { audio: 'remove', trackId: null, loop: true },
      silence: { silenceStart: seconds(0), silenceEnd: seconds(0) },
    };
    expect(presetMatches(removed, treatments({ audio: 'remove', silenceEnd: seconds(2) }))).toBe(
      true,
    );
    expect(presetMatches(removed, treatments({ audio: 'keep', silenceEnd: seconds(2) }))).toBe(
      false,
    );
    // The other sections do not matter.
    expect(
      presetMatches(
        TIKTOK,
        treatments({ audio: 'keep', silenceEnd: seconds(3), trimEnd: frames(12) }),
      ),
    ).toBe(true);
  });

  it('counts only what makes a difference', () => {
    const nothing: Preset = {
      id: 'n',
      name: 'Nothing',
      audio: { audio: 'keep', trackId: null, loop: true },
      silence: { silenceStart: seconds(0), silenceEnd: seconds(0) },
      trim: { trimStart: seconds(0), trimEnd: seconds(0), precision: 'exact' },
      output: { location: 'beside', folder: null },
    };
    // A unit with nothing in it, the precision without trims, the soundtrack of a kept audio,
    // the folder when saving next to the videos.
    expect(
      presetMatches(
        nothing,
        treatments({
          audio: 'keep',
          trackId: 'beach',
          loop: false,
          silenceStart: frames(0),
          trimEnd: frames(0),
          precision: 'fast',
        }),
      ),
    ).toBe(true);
    const beach: Preset = {
      id: 'b',
      name: 'Beach',
      audio: { audio: 'replace', trackId: 'beach', loop: true },
      output: IN_FOLDER,
    };
    const applied = applyPreset(beach, treatments());
    expect(presetMatches(beach, applied)).toBe(true);
    expect(presetMatches(beach, { ...applied, recipe: { ...applied.recipe, loop: false } })).toBe(
      false,
    );
    expect(
      presetMatches(beach, { ...applied, output: { location: 'folder', folder: 'E:\\Other' } }),
    ).toBe(false);
  });
});

describe('presetIssue', () => {
  const presets: readonly Preset[] = [TIKTOK, { ...TIKTOK, id: 'insta', name: 'Instagram' }];

  it('needs a name no other preset has, and something to set', () => {
    expect(presetIssue({ name: 'Reels', trim: TRIM }, presets)).toBeNull();
    expect(presetIssue({ name: '   ', trim: TRIM }, presets)).toBe('Name the preset.');
    expect(presetIssue({ name: ' tiktok', trim: TRIM }, presets)).toBe(
      'A preset is already named “TikTok”.',
    );
    expect(presetIssue({ name: 'Reels' }, presets)).toBe('Choose what the preset sets.');
    expect(presetIssue({ name: '\u200b', trim: TRIM }, presets)).toBe('Name the preset.');
    expect(presetIssue({ name: 'TikTok\u200b', trim: TRIM }, presets)).toBe(
      'A preset is already named “TikTok”.',
    );
    expect(presetIssue({ name: ` ${'🎬'.repeat(60)} `, trim: TRIM }, presets)).toBeNull();
    expect(presetIssue({ name: 'a'.repeat(61), trim: TRIM }, presets)).toBe(
      'Use at most 60 characters for the name.',
    );
  });

  it('lets a preset keep its own name', () => {
    expect(presetIssue({ name: 'TIKTOK', trim: TRIM }, presets, 'tiktok')).toBeNull();
    expect(presetIssue({ name: 'instagram', trim: TRIM }, presets, 'tiktok')).toBe(
      'A preset is already named “Instagram”.',
    );
  });
});

describe('byName', () => {
  it('lists presets by name, numbers in order, whatever the case', () => {
    const named = (name: string): Preset => ({ ...TIKTOK, id: name, name });
    const sorted = [named('clip 10'), named('Reels'), named('clip 2'), named('été')].sort(byName);
    expect(sorted.map((preset) => preset.name)).toEqual(['clip 2', 'clip 10', 'été', 'Reels']);
  });
});
