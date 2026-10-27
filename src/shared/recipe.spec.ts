import { describe, expect, it } from 'vitest';
import type { AudioTrack, Recipe, VideoInfo } from './model';
import { DEFAULT_RECIPE } from './model';
import {
  changesNothing,
  isTrimSet,
  outputDuration,
  outputLabels,
  recipeIssue,
  reencodesVideo,
  silencedDuration,
  silences,
  trimSeconds,
  trims,
  videoIssue,
} from './recipe';

const INFO: VideoInfo = {
  durationSec: 3,
  width: 320,
  height: 240,
  frameRate: 30,
  frameCount: 90,
  videoCodec: 'h264',
  audioCodec: 'aac',
  container: 'mp4',
  sizeBytes: 1000,
};

const TRACK: AudioTrack = {
  id: 'track',
  path: '/music/song.mp3',
  name: 'song.mp3',
  suffix: 'song',
  durationSec: 12,
  status: 'ok',
};

function recipe(patch: Partial<Recipe>): Recipe {
  return { ...DEFAULT_RECIPE, ...patch };
}

const seconds = (amount: number) => ({ amount, unit: 'seconds' }) as const;
const frames = (amount: number) => ({ amount, unit: 'frames' }) as const;

describe('recipe helpers', () => {
  it('tells which trims are set', () => {
    expect(isTrimSet(seconds(0))).toBe(false);
    expect(isTrimSet(frames(1))).toBe(true);
    expect(trims(recipe({}))).toBe(false);
    expect(trims(recipe({ trimEnd: seconds(0.5) }))).toBe(true);
  });

  it('silences only an audio that is kept or replaced', () => {
    expect(silences(recipe({ audio: 'keep' }))).toBe(false);
    expect(silences(recipe({ audio: 'keep', silenceStart: seconds(1) }))).toBe(true);
    expect(silences(recipe({ audio: 'replace', silenceEnd: frames(3) }))).toBe(true);
    expect(silences(recipe({ audio: 'remove', silenceEnd: frames(3) }))).toBe(false);
  });

  it('re-encodes the video only for exact cuts', () => {
    expect(reencodesVideo(recipe({ trimStart: seconds(1), precision: 'exact' }))).toBe(true);
    expect(reencodesVideo(recipe({ trimStart: seconds(1), precision: 'fast' }))).toBe(false);
    expect(reencodesVideo(recipe({ precision: 'exact' }))).toBe(false);
    expect(
      reencodesVideo(recipe({ audio: 'keep', precision: 'exact', silenceStart: seconds(1) })),
    ).toBe(false);
  });

  it('knows a recipe that would only copy the file', () => {
    expect(changesNothing(recipe({ audio: 'keep' }))).toBe(true);
    expect(changesNothing(recipe({ audio: 'keep', trimEnd: frames(2) }))).toBe(false);
    expect(changesNothing(recipe({ audio: 'keep', silenceEnd: frames(2) }))).toBe(false);
    expect(changesNothing(recipe({ audio: 'remove' }))).toBe(false);
  });

  it('converts trims to seconds', () => {
    expect(trimSeconds(seconds(1.5), INFO)).toBe(1.5);
    expect(trimSeconds(frames(15), INFO)).toBe(0.5);
    expect(trimSeconds(frames(0), { ...INFO, frameRate: null })).toBe(0);
    expect(trimSeconds(frames(3), { ...INFO, frameRate: null })).toBeNull();
    expect(outputDuration(recipe({ trimStart: seconds(1), trimEnd: frames(15) }), INFO)).toBe(1.5);
    expect(
      outputDuration(recipe({ trimStart: frames(3) }), { ...INFO, frameRate: null }),
    ).toBeNull();
  });

  it('adds up what the silences mute, when they apply', () => {
    const both = { silenceStart: seconds(0.5), silenceEnd: frames(15) };
    expect(silencedDuration(recipe({ audio: 'keep', ...both }), INFO)).toBe(1);
    expect(silencedDuration(recipe({ audio: 'remove', ...both }), INFO)).toBe(0);
    expect(
      silencedDuration(recipe({ audio: 'keep', ...both }), { ...INFO, frameRate: null }),
    ).toBeNull();
  });
});

describe('recipeIssue', () => {
  it('accepts a recipe that does something', () => {
    expect(recipeIssue(recipe({ audio: 'remove' }), null)).toBeNull();
    expect(recipeIssue(recipe({ audio: 'keep', trimStart: frames(3) }), null)).toBeNull();
    expect(recipeIssue(recipe({ audio: 'keep', silenceStart: seconds(1) }), null)).toBeNull();
    expect(recipeIssue(recipe({ audio: 'replace', trackId: 'track' }), TRACK)).toBeNull();
    expect(
      recipeIssue(recipe({ audio: 'replace', trackId: 'track' }), { ...TRACK, status: 'probing' }),
    ).toBeNull();
  });

  it('refuses a recipe that would only copy the file', () => {
    expect(recipeIssue(recipe({ audio: 'keep' }), null)).toBe(
      'Choose what to do: remove or replace the audio, silence or trim.',
    );
  });

  it('refuses invalid lengths to silence, unless the audio is removed', () => {
    expect(recipeIssue(recipe({ audio: 'keep', silenceStart: seconds(Number.NaN) }), null)).toBe(
      'Enter valid lengths to silence.',
    );
    expect(recipeIssue(recipe({ audio: 'keep', silenceEnd: seconds(-1) }), null)).toBe(
      'Lengths to silence cannot be negative.',
    );
    expect(
      recipeIssue(recipe({ audio: 'replace', trackId: 'track', silenceEnd: frames(0.5) }), TRACK),
    ).toBe('Frames to silence must be whole numbers.');
    // Trims are checked first.
    expect(
      recipeIssue(recipe({ audio: 'keep', trimStart: frames(0.5), silenceEnd: seconds(-1) }), null),
    ).toBe('Frames to trim must be whole numbers.');
    expect(recipeIssue(recipe({ audio: 'remove', silenceEnd: seconds(-1) }), null)).toBeNull();
  });

  it('refuses invalid lengths, even when they are the only trim', () => {
    expect(recipeIssue(recipe({ trimStart: seconds(Number.NaN) }), null)).toBe(
      'Enter valid lengths to trim.',
    );
    expect(recipeIssue(recipe({ audio: 'keep', trimEnd: seconds(-2) }), null)).toBe(
      'Lengths to trim cannot be negative.',
    );
    expect(recipeIssue(recipe({ trimEnd: frames(1.5) }), null)).toBe(
      'Frames to trim must be whole numbers.',
    );
  });

  it('needs a usable replacement soundtrack', () => {
    expect(recipeIssue(recipe({ audio: 'replace', trackId: null }), TRACK)).toBe(
      'Choose the replacement audio.',
    );
    expect(recipeIssue(recipe({ audio: 'replace', trackId: 'track' }), null)).toBe(
      'Choose the replacement audio.',
    );
    expect(
      recipeIssue(recipe({ audio: 'replace', trackId: 'track' }), { ...TRACK, status: 'missing' }),
    ).toBe('song.mp3 is missing: it was moved or deleted.');
    expect(
      recipeIssue(recipe({ audio: 'replace', trackId: 'track' }), {
        ...TRACK,
        status: 'unreadable',
      }),
    ).toBe('song.mp3 cannot be read as audio.');
  });
});

describe('videoIssue', () => {
  it('accepts trims that leave at least one frame', () => {
    expect(videoIssue(recipe({ trimStart: frames(89) }), INFO)).toBeNull();
    expect(videoIssue(recipe({ trimStart: seconds(1), trimEnd: seconds(1.9) }), INFO)).toBeNull();
  });

  it('refuses trims that remove everything', () => {
    const message = 'The trims remove all of it (0:03 long).';
    expect(videoIssue(recipe({ trimStart: frames(90) }), INFO)).toBe(message);
    expect(videoIssue(recipe({ trimStart: seconds(2), trimEnd: seconds(1) }), INFO)).toBe(message);
    expect(videoIssue(recipe({ trimEnd: seconds(5) }), INFO)).toBe(message);
  });

  it('refuses frame trims when the frame rate is unknown', () => {
    const unknownRate = { ...INFO, frameRate: null };
    expect(videoIssue(recipe({ trimEnd: frames(3) }), unknownRate)).toBe(
      'Its frame rate is unknown: trim it in seconds.',
    );
    // A unit left on frames with nothing to trim does not matter.
    expect(
      videoIssue(recipe({ trimStart: frames(0), trimEnd: seconds(1) }), unknownRate),
    ).toBeNull();
  });

  it('refuses silences in frames when the frame rate is unknown', () => {
    const unknownRate = { ...INFO, frameRate: null };
    expect(videoIssue(recipe({ audio: 'keep', silenceEnd: frames(3) }), unknownRate)).toBe(
      'Its frame rate is unknown: silence it in seconds.',
    );
    expect(videoIssue(recipe({ audio: 'keep', silenceEnd: seconds(1) }), unknownRate)).toBeNull();
    expect(videoIssue(recipe({ audio: 'remove', silenceEnd: frames(3) }), unknownRate)).toBeNull();
  });

  it('accepts silences that leave some sound, and refuses those that do not', () => {
    const keep = { audio: 'keep' } as const;
    expect(
      videoIssue(recipe({ ...keep, silenceStart: seconds(1), silenceEnd: frames(59) }), INFO),
    ).toBeNull();
    expect(
      videoIssue(recipe({ ...keep, silenceStart: seconds(1), silenceEnd: frames(60) }), INFO),
    ).toBe('The silences cover all of it (0:03 long): remove the audio instead.');
    expect(
      videoIssue(
        recipe({
          ...keep,
          trimStart: seconds(1),
          silenceStart: seconds(0.5),
          silenceEnd: seconds(2),
        }),
        INFO,
      ),
    ).toBe('The silences cover all of it (0:02 long once trimmed): remove the audio instead.');
    // A removed audio has no silences.
    expect(videoIssue(recipe({ audio: 'remove', silenceStart: seconds(5) }), INFO)).toBeNull();
  });

  it('has nothing to silence in a video without audio, which may still be trimmed', () => {
    const silent = { ...INFO, audioCodec: null };
    expect(videoIssue(recipe({ audio: 'keep', silenceStart: seconds(1) }), silent)).toBe(
      'It has no audio to silence.',
    );
    expect(
      videoIssue(recipe({ audio: 'keep', trimEnd: frames(1), silenceStart: seconds(9) }), silent),
    ).toBeNull();
    // A new soundtrack can be silenced.
    expect(
      videoIssue(recipe({ audio: 'replace', trackId: 'track', silenceStart: seconds(1) }), silent),
    ).toBeNull();
  });
});

describe('outputLabels', () => {
  it('names what was done, audio first', () => {
    const labels = (patch: Partial<typeof DEFAULT_RECIPE>) =>
      outputLabels({ ...DEFAULT_RECIPE, ...patch }, null);
    expect(labels({ audio: 'remove' })).toEqual(['no audio']);
    expect(labels({ audio: 'replace' })).toEqual(['new audio']);
    expect(labels({ audio: 'keep', trimStart: { amount: 2, unit: 'frames' } })).toEqual([
      'trimmed',
    ]);
    expect(labels({ audio: 'remove', trimEnd: { amount: 1, unit: 'seconds' } })).toEqual([
      'no audio',
      'trimmed',
    ]);
    expect(labels({ audio: 'replace', trimEnd: { amount: 1, unit: 'seconds' } })).toEqual([
      'new audio',
      'trimmed',
    ]);
  });

  it('says the audio was muted, last, only when it is kept or replaced', () => {
    const labels = (patch: Partial<typeof DEFAULT_RECIPE>) =>
      outputLabels(
        { ...DEFAULT_RECIPE, silenceEnd: { amount: 1, unit: 'seconds' }, ...patch },
        null,
      );
    expect(labels({ audio: 'keep' })).toEqual(['muted']);
    expect(labels({ audio: 'keep', trimStart: { amount: 2, unit: 'frames' } })).toEqual([
      'trimmed',
      'muted',
    ]);
    expect(labels({ audio: 'replace' })).toEqual(['new audio', 'muted']);
    expect(labels({ audio: 'remove' })).toEqual(['no audio']);
  });

  it('names a replaced audio by the suffix of its soundtrack', () => {
    const replace = { ...DEFAULT_RECIPE, audio: 'replace' } as const;
    expect(outputLabels(replace, 'Beach waves')).toEqual(['Beach waves']);
    expect(
      outputLabels({ ...replace, trimStart: { amount: 1, unit: 'seconds' } }, 'Beach waves'),
    ).toEqual(['Beach waves', 'trimmed']);
    // Only a replaced audio is named after its soundtrack.
    expect(outputLabels({ ...replace, audio: 'remove' }, 'Beach waves')).toEqual(['no audio']);
    expect(outputLabels({ ...replace, audio: 'keep' }, 'Beach waves')).toEqual([]);
  });
});
