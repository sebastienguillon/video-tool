import type { Preset, PresetDraft } from '@shared/model';
import { describe, expect, it } from 'vitest';
import { withoutPreset, withPreset } from './presets';

const seconds = (amount: number) => ({ amount, unit: 'seconds' }) as const;
const frames = (amount: number) => ({ amount, unit: 'frames' }) as const;

const TRIM = { trimStart: seconds(0), trimEnd: frames(12), precision: 'exact' } as const;
const TIKTOK: Preset = { id: 'tiktok', name: 'TikTok', trim: TRIM };
const INSTA: Preset = {
  id: 'insta',
  name: 'Instagram',
  audio: { audio: 'remove', trackId: null, loop: true },
};

describe('withPreset', () => {
  it('adds a new preset at the end, with the id given and its name cleaned up', () => {
    const draft: PresetDraft = {
      name: '  Reels  9:16 ',
      silence: { silenceStart: seconds(0), silenceEnd: seconds(1) },
    };
    const { presets, preset } = withPreset([TIKTOK], draft, 'new-id');
    expect(preset).toEqual({ id: 'new-id', name: 'Reels 9:16', silence: draft.silence });
    expect(presets).toEqual([TIKTOK, preset]);
  });

  it('replaces the preset with the same id, where it was', () => {
    const draft: PresetDraft = {
      id: 'tiktok',
      name: 'tiktok',
      trim: { trimStart: seconds(0), trimEnd: frames(15), precision: 'fast' },
    };
    const { presets, preset } = withPreset([TIKTOK, INSTA], draft, 'unused');
    expect(preset).toEqual({ ...draft, id: 'tiktok' });
    expect(presets).toEqual([preset, INSTA]);
  });

  it('keeps what the settings file keeps: no soundtrack for an audio kept or removed', () => {
    const { preset } = withPreset(
      [],
      { name: 'Keep', audio: { audio: 'keep', trackId: 'beach', loop: false } },
      'id',
    );
    expect(preset.audio).toEqual({ audio: 'keep', trackId: null, loop: true });
  });

  it('refuses what presetIssue refuses, and new versions of presets no longer listed', () => {
    expect(() => withPreset([TIKTOK], { name: 'TIKTOK', trim: TRIM }, 'id')).toThrow(
      'A preset is already named “TikTok”.',
    );
    expect(() => withPreset([TIKTOK], { name: '', trim: TRIM }, 'id')).toThrow('Name the preset.');
    expect(() => withPreset([TIKTOK], { name: 'Empty' }, 'id')).toThrow(
      'Choose what the preset sets.',
    );
    expect(() => withPreset([INSTA], { ...TIKTOK }, 'id')).toThrow(
      'The preset “TikTok” was deleted.',
    );
  });
});

describe('withoutPreset', () => {
  it('forgets a preset, and leaves the list as it is for an unknown id', () => {
    const presets = [TIKTOK, INSTA];
    expect(withoutPreset(presets, 'tiktok')).toEqual([INSTA]);
    expect(withoutPreset(presets, 'gone')).toBe(presets);
  });
});
