import type { Recipe } from '@shared/model';
import { DEFAULT_RECIPE, VIDEO_EXTENSIONS } from '@shared/model';
import { describe, expect, it } from 'vitest';
import type { MediaFeatures } from './media-tools';
import type { FrameTimes, PlanInput } from './plan';
import {
  appliedRecipe,
  firstFrameLookup,
  framesToScan,
  generatesTimes,
  keptRange,
  keyframeLookup,
  outputContainer,
  planJob,
  silencedAudioIssue,
} from './plan';
import type { AudioStream, MediaProbe, SubtitleStream, VideoStream } from './probe';

const ALL_ENCODERS = new Set([
  'libx264',
  'libx265',
  'libvpx-vp9',
  'libsvtav1',
  'libaom-av1',
  'aac',
  'libopus',
  'libvorbis',
]);

/** ffmpeg 6.1 and later. */
const CURRENT: MediaFeatures = { demuxTimeBase: 'demux', fpsMode: '-fps_mode:v' };

interface ProbePatch {
  readonly container?: string;
  readonly video?: Partial<VideoStream>;
  readonly audio?: readonly AudioStream[];
  readonly subtitles?: readonly SubtitleStream[];
  readonly fonts?: readonly number[];
  readonly formatStartSec?: number;
  readonly formatBitRate?: number | null;
  readonly bFrames?: boolean;
}

/** A 3 s, 30 fps, 90 frame video with one stereo audio stream, by default. */
function probeOf(patch: ProbePatch = {}): MediaProbe {
  const video: VideoStream = {
    index: 0,
    codec: 'h264',
    pixFmt: 'yuv420p',
    fullRange: false,
    startSec: 0,
    durationSec: 3,
    frameRate: 30,
    frameCount: 90,
    bitRate: 2_000_000,
    rotation: 0,
    fieldOrder: null,
    ...patch.video,
  };
  const audio = patch.audio ?? [
    { index: 1, codec: 'aac', channels: 2, layout: 'stereo', startSec: 0 },
  ];
  return {
    info: {
      durationSec: video.durationSec,
      width: 320,
      height: 240,
      frameRate: video.frameRate,
      frameCount: video.frameCount,
      videoCodec: video.codec,
      audioCodec: audio.length === 0 ? null : (audio[0]?.codec ?? 'unknown'),
      container: patch.container ?? 'mp4',
      sizeBytes: 1000,
    },
    video,
    audio,
    subtitles: patch.subtitles ?? [],
    fonts: patch.fonts ?? [],
    formatStartSec: patch.formatStartSec ?? 0,
    formatBitRate: patch.formatBitRate === undefined ? 2_200_000 : patch.formatBitRate,
    bFrames: patch.bFrames ?? false,
  };
}

const seconds = (amount: number) => ({ amount, unit: 'seconds' }) as const;
const frames = (amount: number) => ({ amount, unit: 'frames' }) as const;

function recipe(patch: Partial<Recipe>): Recipe {
  return { ...DEFAULT_RECIPE, ...patch };
}

function plan(patch: Partial<PlanInput> & { readonly recipe: Recipe }) {
  const probe = patch.probe ?? probeOf();
  const result = planJob({
    source: '/videos/clip.mp4',
    output: '/videos/.clip.partial-1234abcd.mp4',
    probe,
    encoders: ALL_ENCODERS,
    features: CURRENT,
    track: null,
    totalFrames: probe.video.frameCount,
    frameTimes: null,
    keyframe: null,
    firstFrameSec: null,
    ...patch,
  });
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.plan;
}

function planError(patch: Partial<PlanInput> & { readonly recipe: Recipe }): string {
  const probe = patch.probe ?? probeOf();
  const result = planJob({
    source: '/videos/clip.mp4',
    output: '/videos/.clip.partial-1234abcd.mp4',
    probe,
    encoders: ALL_ENCODERS,
    features: CURRENT,
    track: null,
    totalFrames: probe.video.frameCount,
    frameTimes: null,
    keyframe: null,
    firstFrameSec: null,
    ...patch,
  });
  if (result.ok) {
    throw new Error('Expected the plan to fail');
  }
  return result.message;
}

describe('firstFrameLookup', () => {
  const silence = { audio: 'keep', silenceStart: seconds(1) } as const;

  it('looks for the first frame shown only where planning cannot tell it, for a start silence', () => {
    // A copy from the start: the first frame that decodes.
    expect(firstFrameLookup(recipe(silence), probeOf(), null)).toBeNull();
    // An exact cut in seconds: the first frame at or after the cut.
    expect(firstFrameLookup(recipe({ ...silence, trimStart: seconds(1) }), probeOf(), null)).toBe(
      1 - 0.002,
    );
    // A cut in frames or at a keyframe, a first frame decoded, every frame scanned: known.
    for (const patch of [
      { trimStart: frames(30) },
      { trimStart: seconds(1), precision: 'fast' },
      { trimEnd: seconds(1) },
    ] as const) {
      expect(firstFrameLookup(recipe({ ...silence, ...patch }), probeOf(), null)).toBeUndefined();
    }
    expect(
      firstFrameLookup(recipe({ ...silence, trimStart: seconds(1) }), probeOf(), {
        times: [0, 1, 2],
        complete: true,
      }),
    ).toBeUndefined();
    // Nothing to look for without a start silence.
    expect(
      firstFrameLookup(recipe({ audio: 'keep', silenceEnd: seconds(1) }), probeOf(), null),
    ).toBeUndefined();
  });
});

describe('appliedRecipe', () => {
  it('leaves out the silences of a video without audio, unless a soundtrack replaces it', () => {
    const silenced = recipe({ audio: 'keep', trimEnd: frames(1), silenceStart: seconds(1) });
    expect(appliedRecipe(silenced, probeOf({ audio: [] }))).toEqual({
      ...silenced,
      silenceStart: seconds(0),
    });
    expect(appliedRecipe(silenced, probeOf())).toBe(silenced);
    const replaced = { ...silenced, audio: 'replace' } as const;
    expect(appliedRecipe(replaced, probeOf({ audio: [] }))).toBe(replaced);
  });
});

/** The value after `flag`, or `null` when the flag is absent. */
function option(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index === -1 ? null : (args[index + 1] ?? null);
}

/** Every value given to `flag`. */
function options(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ''] : []));
}

/** A second long, three times shorter than the video. */
const TRACK = { path: '/music/song é.mp3', durationSec: 1, channels: 2, layout: 'stereo' };

describe('outputContainer', () => {
  it('keeps common containers, and the .qt extension becomes .mov', () => {
    for (const container of ['mp4', 'm4v', 'mov', 'mkv', 'webm']) {
      expect(outputContainer(container, true)).toBe(container);
      expect(outputContainer(container, false)).toBe(container);
    }
    expect(outputContainer('qt', false)).toBe('mov');
  });

  it('turns other containers into MP4 when re-encoding, Matroska when copying', () => {
    const others = VIDEO_EXTENSIONS.filter(
      (extension) => !['mp4', 'm4v', 'mov', 'qt', 'mkv', 'webm'].includes(extension),
    );
    expect(others).toEqual(['avi', 'wmv', 'flv', 'mpg', 'mpeg', 'm2ts', 'mts', 'ts', '3gp', 'ogv']);
    for (const container of others) {
      expect(outputContainer(container, true)).toBe('mp4');
      expect(outputContainer(container, false)).toBe('mkv');
    }
  });
});

describe('keptRange', () => {
  const video = probeOf().video;

  it('keeps frames [N, total - M) for trims in frames', () => {
    const result = keptRange(recipe({ trimStart: frames(10), trimEnd: frames(5) }), video, 90);
    expect(result).toEqual({
      ok: true,
      range: { fromSec: 10 / 30, untilSec: 85 / 30, frames: 75 },
    });
  });

  it('rounds seconds up to the next frame', () => {
    const range = (trimStart: number, trimEnd: number, frameRate = 30) =>
      keptRange(
        recipe({ trimStart: seconds(trimStart), trimEnd: seconds(trimEnd) }),
        { ...video, frameRate, durationSec: 90 / frameRate },
        90,
      );
    // 0.5 s at 30 fps: frames 0 to 14 go, frame 15 (at 0.5 s exactly) stays. An end in seconds is
    // a time: no frame count.
    expect(range(0.5, 1)).toEqual({
      ok: true,
      range: { fromSec: 0.5, untilSec: 2, frames: null },
    });
    // 0.51 s: frame 15 is before it, so it goes too.
    expect(range(0.51, 0)).toMatchObject({ range: { fromSec: 16 / 30, untilSec: null } });
    // 29.97 fps: frame 15 is at 0.5005 s, the first one after 0.5 s.
    expect(range(0.5, 0, 30000 / 1001)).toMatchObject({ range: { fromSec: 15 / (30000 / 1001) } });
  });

  it('counts from the first frame of the video stream, not the format', () => {
    const result = keptRange(
      recipe({ trimStart: frames(3), trimEnd: seconds(1) }),
      {
        ...video,
        startSec: 0.5,
      },
      90,
    );
    expect(result).toEqual({
      ok: true,
      range: { fromSec: 0.5 + 0.1, untilSec: 0.5 + 2, frames: null },
    });
  });

  it('never ends past the last frame', () => {
    const result = keptRange(recipe({ trimEnd: seconds(0.1) }), { ...video, durationSec: 3.5 }, 90);
    expect(result).toMatchObject({ range: { untilSec: 3, frames: null } });
  });

  describe('with the times the frames show', () => {
    // 30 fps for 2 s, then 2 fps for 2 s: 64 frames in 4 s, 16 fps on average.
    const times = [...Array.from({ length: 60 }, (_, index) => index / 30), ...[2, 2.5, 3, 3.5]];
    const vfr = { ...video, durationSec: 4, frameRate: 16, frameCount: 64 };
    const all: FrameTimes = { times, complete: true };

    it('cuts trims in frames at the time their frame shows', () => {
      expect(
        keptRange(recipe({ trimStart: frames(10), trimEnd: frames(2) }), vfr, null, all),
      ).toEqual({ ok: true, range: { fromSec: 10 / 30, untilSec: 3, frames: 52 } });
      // On the average frame rate's grid, frame 10 would be at 0.625 s: frame 19.
      expect(keptRange(recipe({ trimStart: frames(10) }), vfr, 64)).toMatchObject({
        range: { fromSec: 0.625 },
      });
    });

    it('counts the frames scanned, not those the container records', () => {
      // An edit list hides 15 frames that MP4 counts all the same.
      const shown: FrameTimes = { times: times.slice(0, 50), complete: true };
      expect(keptRange(recipe({ trimEnd: frames(5) }), vfr, 64, shown)).toMatchObject({
        range: { untilSec: 45 / 30, frames: 45 },
      });
    });

    it('keeps seconds as times, counting the frames kept on the real time line', () => {
      // From 2 s to the frame 2 before the end, at 3 s: the frames at 2 and 2.5 s.
      expect(
        keptRange(recipe({ trimStart: seconds(2), trimEnd: frames(2) }), vfr, null, all),
      ).toEqual({ ok: true, range: { fromSec: 2, untilSec: 3, frames: 2 } });
      expect(keptRange(recipe({ trimEnd: seconds(1) }), vfr, null, all)).toEqual({
        ok: true,
        range: { fromSec: null, untilSec: 3, frames: null },
      });
      // From frame 60 (2 s) to 2.5 s: one frame, though 2.5 s is frame 40 on the grid.
      expect(
        keptRange(recipe({ trimStart: frames(60), trimEnd: seconds(1.5) }), vfr, null, all),
      ).toEqual({ ok: true, range: { fromSec: 2, untilSec: 2.5, frames: null } });
    });

    it('needs only the first frames for a start in frames', () => {
      const first: FrameTimes = { times: times.slice(0, 40), complete: false };
      expect(keptRange(recipe({ trimStart: frames(30) }), vfr, 64, first)).toMatchObject({
        range: { fromSec: 1, untilSec: null },
      });
      // Up to 2.5 s from frame 60 (2 s): one frame is left.
      const late: FrameTimes = { times: times.slice(0, 64), complete: false };
      expect(
        keptRange(recipe({ trimStart: frames(60), trimEnd: seconds(1.5) }), vfr, 64, late),
      ).toEqual({ ok: true, range: { fromSec: 2, untilSec: 2.5, frames: null } });
      expect(
        keptRange(recipe({ trimStart: frames(61), trimEnd: seconds(1.5) }), vfr, 64, late),
      ).toEqual({ ok: false, message: 'The trims remove all of it (0:04 long).' });
    });

    it('refuses cuts that keep no scanned frame', () => {
      const message = 'The trims remove all of it (0:04 long).';
      expect(keptRange(recipe({ trimStart: frames(64) }), vfr, null, all)).toEqual({
        ok: false,
        message,
      });
      expect(
        keptRange(recipe({ trimStart: frames(32), trimEnd: frames(32) }), vfr, null, all),
      ).toEqual({ ok: false, message });
      expect(keptRange(recipe({ trimStart: frames(63) }), vfr, null, all)).toMatchObject({
        ok: true,
        range: { fromSec: 3.5 },
      });
    });
  });

  it('needs the frame count for an end trim in frames', () => {
    expect(keptRange(recipe({ trimEnd: frames(5) }), video, null)).toEqual({
      ok: false,
      message: 'Its number of frames is unknown: trim its end in seconds.',
    });
  });

  it('works in seconds when the frame rate is unknown, and refuses frames then', () => {
    const unknownRate = { ...video, frameRate: null, startSec: 0.2 };
    expect(
      keptRange(recipe({ trimStart: seconds(1), trimEnd: seconds(0.5) }), unknownRate, null),
    ).toEqual({
      ok: true,
      range: { fromSec: 1.2, untilSec: 2.7, frames: null },
    });
    expect(keptRange(recipe({ trimStart: frames(2) }), unknownRate, null)).toEqual({
      ok: false,
      message: 'Its frame rate is unknown: trim it in seconds.',
    });
  });

  it('refuses cuts that keep nothing', () => {
    const message = 'The trims remove all of it (0:03 long).';
    expect(keptRange(recipe({ trimStart: frames(90) }), video, 90)).toEqual({ ok: false, message });
    expect(keptRange(recipe({ trimStart: frames(45), trimEnd: frames(45) }), video, 90)).toEqual({
      ok: false,
      message,
    });
    expect(keptRange(recipe({ trimEnd: frames(100) }), video, 90)).toEqual({ ok: false, message });
    expect(keptRange(recipe({ trimStart: seconds(3) }), video, null)).toEqual({
      ok: false,
      message,
    });
    expect(keptRange(recipe({ trimStart: frames(89) }), video, 90)).toMatchObject({ ok: true });
  });
});

describe('planJob', () => {
  it('copies the video without its audio', () => {
    const { args, durationSec } = plan({ recipe: recipe({ audio: 'remove' }) });
    expect(args).toEqual([
      ...['-i', '/videos/clip.mp4', '-map', '0:0'],
      ...['-map_metadata', '0', '-map_chapters', '0', '-dn', '-c:v', 'copy', '-an'],
      ...['-write_tmcd', '0', '-f', 'mp4', '/videos/.clip.partial-1234abcd.mp4'],
    ]);
    expect(durationSec).toBe(3);
  });

  it('cuts exact frames: seeks just before the first one, stops after the last one', () => {
    const { args, durationSec } = plan({
      recipe: recipe({ audio: 'keep', trimStart: frames(10), trimEnd: frames(5) }),
    });
    // The length ends the video and its audio a margin before the first frame removed.
    expect(args).toEqual([
      ...['-ss', '0.331333', '-i', '/videos/clip.mp4', '-map', '0:0', '-map', '0:1'],
      ...['-map_metadata', '0', '-map_chapters', '0', '-dn'],
      ...['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-enc_time_base:v', 'demux'],
      ...['-fps_mode:v', 'passthrough', '-c:a', 'aac', '-b:a:0', '192k', '-t', '2.498000'],
      ...['-write_tmcd', '0', '-f', 'mp4', '/videos/.clip.partial-1234abcd.mp4'],
    ]);
    expect(durationSec).toBeCloseTo(2.5, 9);
  });

  it('stops a silent result on its last frame by counting them', () => {
    // With audio, -frames:v would end it where the encoding is: short of the video.
    const silent = plan({
      recipe: recipe({ audio: 'remove', trimStart: frames(10), trimEnd: frames(5) }),
    });
    expect(option(silent.args, '-frames:v')).toBe('75');
    expect(option(silent.args, '-t')).toBe('2.500000');
    const mute = plan({
      probe: probeOf({ audio: [] }),
      recipe: recipe({ audio: 'keep', trimEnd: frames(5) }),
    });
    expect(option(mute.args, '-frames:v')).toBe('85');
    const soundtrack = plan({
      recipe: recipe({ audio: 'replace', trackId: 'song', trimEnd: frames(5) }),
      track: TRACK,
    });
    expect(option(soundtrack.args, '-frames:v')).toBeNull();
    expect(option(soundtrack.args, '-t')).toBe((85 / 30 - 0.002).toFixed(6));
  });

  it('keeps the timestamps of exact cuts with the options older versions have', () => {
    const exact = (features: MediaFeatures) =>
      plan({ recipe: recipe({ trimStart: frames(10) }), features }).args;
    // ffmpeg 5.1 and 6.0.
    const older = exact({ demuxTimeBase: '-1', fpsMode: '-fps_mode:v' });
    expect(option(older, '-enc_time_base:v')).toBe('-1');
    expect(option(older, '-fps_mode:v')).toBe('passthrough');
    // ffmpeg 4.4, whose -vsync applies to the whole output.
    const oldest = exact({ demuxTimeBase: '-1', fpsMode: '-vsync' });
    expect(option(oldest, '-vsync')).toBe('passthrough');
    expect(oldest).not.toContain('-fps_mode:v');
    // Copies keep their timestamps anyway.
    const copy = plan({
      recipe: recipe({ precision: 'fast', trimStart: frames(10) }),
      features: { demuxTimeBase: null, fpsMode: null },
    }).args;
    expect(copy).not.toContain('-enc_time_base:v');
    expect(
      planError({
        recipe: recipe({ trimStart: frames(10) }),
        features: { demuxTimeBase: null, fpsMode: '-vsync' },
      }),
    ).toBe('This ffmpeg is too old to cut exactly: update it, or choose fast cuts.');
  });

  it('seeks relative to the format start, which may differ from the video start', () => {
    // Video delayed by two frames (B-frames, no edit list).
    const delayed = probeOf({ video: { startSec: 2 / 30 } });
    const exact = plan({ probe: delayed, recipe: recipe({ trimStart: frames(10) }) });
    expect(option(exact.args, '-ss')).toBe((12 / 30 - 0.002).toFixed(6));
    // Audio starting before the video (Matroska codec delay).
    const early = probeOf({ formatStartSec: -0.021 });
    const cut = plan({
      probe: early,
      recipe: recipe({ trimStart: frames(10), trimEnd: frames(5) }),
    });
    expect(option(cut.args, '-ss')).toBe((10 / 30 - 0.002 + 0.021).toFixed(6));
    expect(option(cut.args, '-t')).toBe('2.500000');
  });

  it('cuts only the end without seeking, the length counted from the format start', () => {
    const { args, durationSec } = plan({
      probe: probeOf({ formatStartSec: -0.021 }),
      recipe: recipe({ trimEnd: frames(7) }),
    });
    expect(option(args, '-ss')).toBeNull();
    expect(option(args, '-frames:v')).toBe('83');
    expect(option(args, '-t')).toBe((83 / 30 + 0.021).toFixed(6));
    expect(durationSec).toBeCloseTo(83 / 30 + 0.021, 9);
  });

  it('keeps everything after a start trim without bounding the length', () => {
    const { args } = plan({ recipe: recipe({ audio: 'keep', trimStart: seconds(1) }) });
    expect(option(args, '-ss')).toBe('0.998000');
    expect(option(args, '-t')).toBeNull();
    expect(option(args, '-frames:v')).toBeNull();
  });

  it('cuts in seconds without frame alignment when the frame rate is unknown', () => {
    const { args } = plan({
      probe: probeOf({ video: { frameRate: null, frameCount: null } }),
      recipe: recipe({ trimStart: seconds(1), trimEnd: seconds(0.5) }),
    });
    expect(option(args, '-ss')).toBe('0.999000');
    expect(option(args, '-t')).toBe('1.499000');
    expect(option(args, '-frames:v')).toBeNull();
  });

  it('ends a cut in seconds by its length alone, just before the first frame removed', () => {
    // A frame count from the average frame rate would stop a variable frame rate video early.
    const seeked = plan({
      recipe: recipe({ audio: 'keep', trimStart: frames(10), trimEnd: seconds(0.5) }),
    });
    expect(option(seeked.args, '-frames:v')).toBeNull();
    expect(option(seeked.args, '-t')).toBe((65 / 30 - 0.002).toFixed(6));
    const unseeked = plan({ recipe: recipe({ audio: 'keep', trimEnd: seconds(1) }) });
    expect(option(unseeked.args, '-ss')).toBeNull();
    expect(option(unseeked.args, '-frames:v')).toBeNull();
    expect(option(unseeked.args, '-t')).toBe((2 - 0.002).toFixed(6));
    // A stream copy cuts in decoding order anyway.
    const fast = plan({ recipe: recipe({ precision: 'fast', trimEnd: seconds(1) }) });
    expect(option(fast.args, '-t')).toBe('2.000000');
  });

  it('cuts trims in frames at the times scanned', () => {
    // 30 fps for 2 s, then 2 fps: frame 62 shows at 3 s.
    const times = [...Array.from({ length: 60 }, (_, index) => index / 30), ...[2, 2.5, 3, 3.5]];
    const { args } = plan({
      probe: probeOf({ video: { durationSec: 4, frameRate: 16, frameCount: 64 } }),
      recipe: recipe({ audio: 'remove', trimStart: frames(10), trimEnd: frames(2) }),
      frameTimes: { times, complete: true },
    });
    expect(option(args, '-ss')).toBe((10 / 30 - 0.002).toFixed(6));
    expect(option(args, '-frames:v')).toBe('52');
    expect(option(args, '-t')).toBe((3 - 10 / 30).toFixed(6));
  });

  it('fast cuts start at the keyframe found before the cut, and copy everything', () => {
    const { args, durationSec } = plan({
      recipe: recipe({
        audio: 'keep',
        precision: 'fast',
        trimStart: frames(20),
        trimEnd: frames(5),
      }),
      keyframe: { ptsSec: 0.5, dtsSec: 0.5 - 2 / 30 },
    });
    expect(args.slice(0, 5)).toEqual(['-ss', '0.502000', '-itsoffset', '0.002000', '-i']);
    expect(option(args, '-c:v')).toBe('copy');
    expect(option(args, '-c:a')).toBe('copy');
    // The keyframe shows at 0: the length counts from it.
    expect(option(args, '-t')).toBe((85 / 30 - 0.5).toFixed(6));
    expect(option(args, '-avoid_negative_ts')).toBe('make_zero');
    expect(option(args, '-frames:v')).toBeNull();
    expect(durationSec).toBeCloseTo(85 / 30 - 0.5, 9);
  });

  it('fast cuts seek at the cut itself when no keyframe was found', () => {
    const { args } = plan({ recipe: recipe({ precision: 'fast', trimStart: seconds(1) }) });
    expect(option(args, '-ss')).toBe('1.002000');
    expect(args).not.toContain('-itsoffset');
  });

  it('makes up for the early seeks of ffmpeg in containers with B-frames, outside MP4 and MOV', () => {
    const keyframe = { ptsSec: 1.021, dtsSec: 1.021 - 2 / 30 };
    const cut = (container: string, bFrames: boolean) =>
      plan({
        probe: probeOf({ container, bFrames, video: { startSec: 0.021 } }),
        recipe: recipe({
          audio: 'replace',
          trackId: 'song',
          precision: 'fast',
          trimStart: frames(35),
        }),
        track: TRACK,
        keyframe,
      }).args;
    // ffmpeg seeks Matroska, WebM, AVI and FLV 3/23 s before -ss when a stream has B-frames.
    for (const container of ['mkv', 'webm', 'avi', 'flv']) {
      const args = cut(container, true);
      expect(option(args, '-ss'), container).toBe((1.023 + 3 / 23).toFixed(6));
      expect(option(args, '-itsoffset'), container).toBe((0.002 + 3 / 23).toFixed(6));
      // The soundtrack starts with the keyframe, at 0, and ends with the video.
      expect(option(args, '-t'), container).toBe((3.021 - 1.021).toFixed(6));
    }
    expect(option(cut('mkv', false), '-ss')).toBe('1.023000');
    for (const container of ['mp4', 'm4v', 'mov', 'qt', '3gp']) {
      expect(option(cut(container, true), '-ss'), container).toBe('1.023000');
      expect(option(cut(container, true), '-itsoffset'), container).toBe('0.002000');
    }
    // Exact cuts decode from wherever the seek lands, and drop what comes before the cut.
    const exact = plan({
      probe: probeOf({ container: 'mkv', bFrames: true }),
      recipe: recipe({ trimStart: frames(30) }),
    });
    expect(option(exact.args, '-ss')).toBe((1 - 0.002).toFixed(6));
  });

  it('fast end cuts need neither a seek nor a timestamp shift', () => {
    const { args } = plan({ recipe: recipe({ precision: 'fast', trimEnd: seconds(1) }) });
    expect(option(args, '-ss')).toBeNull();
    expect(option(args, '-t')).toBe('2.000000');
    expect(option(args, '-avoid_negative_ts')).toBeNull();
  });

  it('replaces the audio with a looped soundtrack, bounded by the video', () => {
    const { args, durationSec } = plan({
      recipe: recipe({ audio: 'replace', trackId: 'song', loop: true }),
      track: TRACK,
    });
    // Three times through: it starts over twice. Rounding is padded with silence.
    expect(args).toEqual([
      ...['-i', '/videos/clip.mp4', '-stream_loop', '2', '-i', '/music/song é.mp3'],
      ...['-map', '0:0', '-map', '1:a:0', '-map_metadata', '0', '-map_chapters', '0', '-dn'],
      ...['-c:v', 'copy', '-c:a', 'aac', '-b:a:0', '192k', '-filter:a:0', 'apad'],
      ...['-t', '3.000000', '-write_tmcd', '0', '-f', 'mp4', '/videos/.clip.partial-1234abcd.mp4'],
    ]);
    expect(durationSec).toBe(3);
  });

  it('starts a soundtrack over as many times as the video takes, and no more', () => {
    // ffmpeg 6.0 never exits when the result ends while a looped input would start over again.
    const loops = (trackSec: number, trim = 0) =>
      option(
        plan({
          recipe: recipe({ audio: 'replace', trackId: 'song', trimStart: frames(trim) }),
          track: { ...TRACK, durationSec: trackSec },
        }).args,
        '-stream_loop',
      );
    expect(loops(2.5)).toBe('1');
    expect(loops(3)).toBe('0');
    expect(loops(95)).toBe('0');
    expect(loops(0.7)).toBe('4');
    // From frame 30 to the end: 2 s.
    expect(loops(1, 30)).toBe('1');
  });

  it('pads a soundtrack that does not loop with silence', () => {
    const { args } = plan({
      recipe: recipe({ audio: 'replace', trackId: 'song', loop: false }),
      track: TRACK,
    });
    expect(args).not.toContain('-stream_loop');
    expect(option(args, '-filter:a:0')).toBe('apad');
    expect(option(args, '-t')).toBe('3.000000');
  });

  it('gives channels in an unknown order the usual layout, which encoders require', () => {
    const layoutOf = (channels: number, layout: string | null) =>
      option(
        plan({
          recipe: recipe({ audio: 'replace', trackId: 'song' }),
          track: { ...TRACK, channels, layout },
        }).args,
        '-filter:a:0',
      );
    expect(layoutOf(6, null)).toBe('aresample,aformat=channel_layouts=5.1,apad');
    expect(layoutOf(8, null)).toBe('aresample,aformat=channel_layouts=7.1,apad');
    expect(layoutOf(1, null)).toBe('aresample,aformat=channel_layouts=mono,apad');
    expect(layoutOf(12, null)).toBe('aresample,aformat=channel_layouts=7.1,apad');
    // AAC takes any known layout.
    expect(layoutOf(6, '5.1(side)')).toBe('apad');
    expect(layoutOf(8, '7.1(wide)')).toBe('apad');
  });

  it('bounds a new soundtrack by the cut video, from its first frame', () => {
    const exact = plan({
      recipe: recipe({ audio: 'replace', trackId: 'song', trimStart: frames(10) }),
      track: TRACK,
    });
    expect(option(exact.args, '-t')).toBe((80 / 30).toFixed(6));
    expect(option(exact.args, '-c:v')).toBe('libx264');
    const fast = plan({
      recipe: recipe({
        audio: 'replace',
        trackId: 'song',
        precision: 'fast',
        trimStart: frames(20),
      }),
      track: TRACK,
      keyframe: { ptsSec: 0.5, dtsSec: 0.5 - 2 / 30 },
    });
    expect(option(fast.args, '-t')).toBe((3 - 0.5).toFixed(6));
  });

  it('needs the soundtrack to replace the audio', () => {
    expect(planError({ recipe: recipe({ audio: 'replace', trackId: 'song' }) })).toBe(
      'Choose the replacement audio.',
    );
  });

  describe('with audio that ffmpeg cannot decode', () => {
    // An iPhone video: stereo AAC, spatial audio (APAC, no decoder) and, here, a 5.1 AC-3 track.
    const iphone = (container: string) =>
      probeOf({
        container,
        audio: [
          { index: 1, codec: 'aac', channels: 2, layout: 'stereo', startSec: 0 },
          { index: 2, codec: null, channels: 4, layout: null, startSec: 0 },
          { index: 3, codec: 'ac3', channels: 6, layout: '5.1(side)', startSec: 0 },
        ],
      });

    it('copies it into MOV while encoding the others, each with its own options', () => {
      const exact = plan({
        probe: iphone('mov'),
        recipe: recipe({ audio: 'keep', trimStart: frames(1) }),
      });
      expect(options(exact.args, '-map')).toEqual(['0:0', '0:1', '0:2', '0:3']);
      const audio = exact.args.slice(exact.args.indexOf('-c:a'), exact.args.indexOf('-write_tmcd'));
      expect(audio).toEqual(['-c:a', 'aac', '-b:a:0', '192k', '-c:a:1', 'copy', '-b:a:2', '384k']);
      expect(exact.droppedAudio).toEqual([]);
      const fast = plan({
        probe: iphone('mov'),
        recipe: recipe({ audio: 'keep', precision: 'fast', trimStart: frames(1) }),
      });
      expect(options(fast.args, '-map')).toEqual(['0:0', '0:1', '0:2', '0:3']);
      expect(options(fast.args, '-c:a')).toEqual(['copy']);
    });

    it('leaves it out of other containers, which refuse it', () => {
      const exact = plan({
        probe: iphone('mp4'),
        recipe: recipe({ audio: 'keep', trimStart: frames(1) }),
      });
      expect(options(exact.args, '-map')).toEqual(['0:0', '0:1', '0:3']);
      expect(option(exact.args, '-b:a:1')).toBe('384k');
      expect(exact.args).not.toContain('-c:a:1');
      expect(exact.droppedAudio).toEqual([2]);
      const fast = plan({
        probe: iphone('mkv'),
        recipe: recipe({ audio: 'keep', precision: 'fast', trimEnd: seconds(1) }),
      });
      expect(options(fast.args, '-map')).toEqual(['0:0', '0:1', '0:3']);
      expect(fast.droppedAudio).toEqual([2]);
      // Removing or replacing the audio leaves nothing out.
      expect(
        plan({ probe: iphone('mp4'), recipe: recipe({ audio: 'remove' }) }).droppedAudio,
      ).toEqual([]);
    });

    it('needs no audio encoder when it is the only audio', () => {
      const { args } = plan({
        probe: probeOf({
          container: 'mov',
          audio: [{ index: 1, codec: null, channels: 4, layout: null, startSec: 0 }],
        }),
        recipe: recipe({ audio: 'keep', trimStart: frames(1) }),
        encoders: new Set(['libx264']),
      });
      expect(options(args, '-c:a')).toEqual(['copy']);
    });
  });

  it('re-encodes every audio stream kept by an exact cut, at a rate for its channels', () => {
    const { args } = plan({
      probe: probeOf({
        audio: [
          { index: 1, codec: 'aac', channels: 2, layout: 'stereo', startSec: 0 },
          { index: 2, codec: 'ac3', channels: 6, layout: '5.1(side)', startSec: 0 },
        ],
      }),
      recipe: recipe({ audio: 'keep', trimStart: frames(1) }),
    });
    expect(options(args, '-map')).toEqual(['0:0', '0:1', '0:2']);
    expect(option(args, '-b:a:0')).toBe('192k');
    expect(option(args, '-b:a:1')).toBe('384k');
  });

  it('needs no audio encoder for a silent video', () => {
    const { args } = plan({
      probe: probeOf({ audio: [] }),
      recipe: recipe({ audio: 'keep', trimStart: frames(1) }),
      encoders: new Set(['libx264']),
    });
    expect(args).not.toContain('-c:a');
  });

  it('keeps the codec family when re-encoding', () => {
    const codecOf = (codec: string, container: string) =>
      option(
        plan({
          probe: probeOf({ container, video: { codec } }),
          recipe: recipe({ trimStart: frames(1) }),
        }).args,
        '-c:v',
      );
    expect(codecOf('h264', 'mkv')).toBe('libx264');
    expect(codecOf('hevc', 'mp4')).toBe('libx265');
    expect(codecOf('vp9', 'webm')).toBe('libvpx-vp9');
    expect(codecOf('vp8', 'webm')).toBe('libvpx-vp9');
    expect(codecOf('av1', 'mkv')).toBe('libsvtav1');
    expect(codecOf('mpeg4', 'avi')).toBe('libx264');
    expect(codecOf('wmv3', 'wmv')).toBe('libx264');
    expect(codecOf('mpeg2video', 'mkv')).toBe('libx264');
    // MOV takes neither AV1 nor VP9.
    expect(codecOf('av1', 'mov')).toBe('libx264');
  });

  it('makes H.264 that plays everywhere from sources in other formats', () => {
    const encoded = (video: Partial<VideoStream>, encoders: readonly string[] = ['libx264']) =>
      plan({
        probe: probeOf({ container: 'mov', video }),
        recipe: recipe({ trimStart: frames(1) }),
        encoders: new Set(encoders),
      }).args;
    // Camera MJPEG (full range), ProRes 10-bit, RGB.
    for (const [codec, pixFmt] of [
      ['mjpeg', 'yuvj422p'],
      ['prores', 'yuv422p10le'],
      ['qtrle', 'rgb24'],
      ['dnxhd', null],
    ] as const) {
      const args = encoded({ codec, pixFmt });
      expect(option(args, '-c:v'), codec).toBe('libx264');
      expect(option(args, '-pix_fmt'), codec).toBe('yuv420p');
    }
    expect(option(encoded({ codec: 'mjpeg', pixFmt: 'yuvj420p' }), '-pix_fmt')).toBeNull();
    // Full range stays full range with x264, said outright for ffmpeg 6.1 and older.
    const camera = encoded({ codec: 'mjpeg', pixFmt: 'yuvj422p', fullRange: true });
    expect(option(camera, '-filter:v')).toBe('scale=out_range=pc');
    expect(option(camera, '-pix_fmt')).toBe('yuv420p');
    expect(option(camera, '-color_range')).toBe('pc');
    const limited = encoded({ codec: 'mjpeg', pixFmt: 'yuvj422p', fullRange: true }, ['h264_mf']);
    expect(option(limited, '-filter:v')).toBeNull();
    expect(option(limited, '-color_range')).toBeNull();
    // H.264 re-encoded by x264 stays as it was.
    expect(option(encoded({ codec: 'h264', pixFmt: 'yuv422p10le' }), '-pix_fmt')).toBeNull();
    // The OS encoders and OpenH264 take 8-bit 4:2:0 only.
    const hardware = encoded({ codec: 'h264', pixFmt: 'yuv420p10le' }, ['h264_videotoolbox']);
    expect(option(hardware, '-c:v')).toBe('h264_videotoolbox');
    expect(option(hardware, '-pix_fmt')).toBe('yuv420p');
    expect(option(encoded({ codec: 'h264', pixFmt: 'nv12' }, ['h264_mf']), '-pix_fmt')).toBeNull();
    // HEVC stays HEVC, 10-bit included; without x265, it becomes H.264 that plays everywhere.
    expect(
      option(encoded({ codec: 'hevc', pixFmt: 'yuv420p10le' }, ['libx265']), '-pix_fmt'),
    ).toBeNull();
    expect(option(encoded({ codec: 'hevc', pixFmt: 'yuv420p10le' }), '-pix_fmt')).toBe('yuv420p');
  });

  it('keeps interlaced video interlaced with x264, field order included', () => {
    const encoded = (video: Partial<VideoStream>, encoders: readonly string[] = ['libx264']) =>
      plan({
        probe: probeOf({ container: 'm2ts', video }),
        recipe: recipe({ trimStart: frames(1) }),
        encoders: new Set(encoders),
      }).args;
    const top = encoded({ fieldOrder: 'tff' });
    expect(top.slice(top.indexOf('-flags'), top.indexOf('-flags') + 4)).toEqual([
      ...['-flags', '+ildct+ilme', '-x264-params', 'tff=1'],
    ]);
    expect(option(top, '-filter:v')).toBeNull();
    expect(option(encoded({ fieldOrder: 'bff' }), '-x264-params')).toBe('bff=1');
    // 4:2:2 to 4:2:0, field by field.
    const camera = encoded({ codec: 'mpeg2video', pixFmt: 'yuv422p', fieldOrder: 'tff' });
    expect(option(camera, '-filter:v')).toBe('scale=interl=1');
    expect(
      option(
        encoded({ codec: 'mjpeg', pixFmt: 'yuvj422p', fullRange: true, fieldOrder: 'bff' }),
        '-filter:v',
      ),
    ).toBe('scale=interl=1:out_range=pc');
    expect(option(camera, '-pix_fmt')).toBe('yuv420p');
    expect(option(encoded({}), '-flags')).toBeNull();
  });

  it('deinterlaces for encoders that cannot code fields, one frame per frame', () => {
    const encoded = (video: Partial<VideoStream>, encoders: readonly string[]) =>
      plan({
        probe: probeOf({ container: 'mkv', video }),
        recipe: recipe({ trimStart: frames(1) }),
        encoders: new Set(encoders),
      }).args;
    const hevc = encoded({ codec: 'hevc', fieldOrder: 'tff' }, ['libx265']);
    expect(option(hevc, '-filter:v')).toBe('bwdif=mode=send_frame:parity=tff');
    expect(hevc).not.toContain('-flags');
    const os = encoded({ codec: 'mpeg2video', pixFmt: 'yuv422p', fieldOrder: 'bff' }, ['h264_mf']);
    expect(option(os, '-filter:v')).toBe('bwdif=mode=send_frame:parity=bff');
    expect(option(os, '-pix_fmt')).toBe('yuv420p');
  });

  it('copies AVI and MPEG program streams with presentation times worked out', () => {
    const avi = (patch: Partial<VideoStream> = {}) => probeOf({ container: 'avi', video: patch });
    const removed = plan({ probe: avi(), recipe: recipe({ audio: 'remove' }) });
    expect(removed.args.slice(0, 4)).toEqual(['-fflags', '+genpts', '-i', '/videos/clip.mp4']);
    const fast = plan({
      probe: avi(),
      recipe: recipe({ audio: 'keep', precision: 'fast', trimStart: seconds(1) }),
    });
    expect(fast.args.slice(0, 4)).toEqual(['-fflags', '+genpts', '-ss', '1.002000']);
    expect(generatesTimes(recipe({ audio: 'remove' }), avi())).toBe(true);
    expect(generatesTimes(recipe({ trimStart: seconds(1) }), avi())).toBe(false);
    expect(generatesTimes(recipe({ audio: 'remove' }), probeOf({ container: 'mkv' }))).toBe(false);
    // Exact cuts decode the video, which needs no presentation times.
    const exact = plan({ probe: avi(), recipe: recipe({ trimStart: seconds(1) }) });
    expect(exact.args).not.toContain('-fflags');
    expect(plan({ recipe: recipe({ audio: 'remove' }) }).args).not.toContain('-fflags');
    // MPEG program streams time packets, which small frames share; transport streams are fine.
    const copied = (container: string) =>
      plan({ probe: probeOf({ container }), recipe: recipe({ audio: 'remove' }) }).args;
    expect(copied('mpg').slice(0, 2)).toEqual(['-fflags', '+genpts']);
    expect(copied('mpeg').slice(0, 2)).toEqual(['-fflags', '+genpts']);
    expect(copied('ts')).not.toContain('-fflags');
    const divx = plan({ probe: avi({ codec: 'mpeg4' }), recipe: recipe({ audio: 'remove' }) });
    expect(option(divx.args, '-bsf:v')).toBe('mpeg4_unpack_bframes');
    expect(option(removed.args, '-bsf:v')).toBeNull();
    const reencoded = plan({
      probe: avi({ codec: 'mpeg4' }),
      recipe: recipe({ trimEnd: frames(1) }),
    });
    expect(option(reencoded.args, '-bsf:v')).toBeNull();
  });

  it('tags HEVC for Apple players, except in Matroska', () => {
    const tagOf = (container: string) =>
      option(
        plan({
          probe: probeOf({ container, video: { codec: 'hevc' } }),
          recipe: recipe({ trimEnd: frames(1) }),
        }).args,
        '-tag:v',
      );
    expect(tagOf('mp4')).toBe('hvc1');
    expect(tagOf('mov')).toBe('hvc1');
    expect(tagOf('m4v')).toBe('hvc1');
    expect(tagOf('mkv')).toBeNull();
  });

  it('falls back to other encoders, at the source bit rate for those without a quality scale', () => {
    const encoded = (encoders: readonly string[], patch: ProbePatch = {}) =>
      plan({
        probe: probeOf(patch),
        recipe: recipe({ trimStart: frames(1) }),
        encoders: new Set([...encoders, 'aac']),
      }).args;
    expect(option(encoded(['h264_mf']), '-c:v')).toBe('h264_mf');
    expect(option(encoded(['h264_mf']), '-b:v')).toBe('2000000');
    expect(option(encoded(['h264_videotoolbox', 'libopenh264']), '-c:v')).toBe('h264_videotoolbox');
    expect(option(encoded(['libopenh264'], { video: { bitRate: null } }), '-b:v')).toBe('2200000');
    expect(
      option(encoded(['libopenh264'], { video: { bitRate: null }, formatBitRate: null }), '-b:v'),
    ).toBe('8000000');
    expect(option(encoded(['libx264'], { video: { codec: 'hevc' } }), '-c:v')).toBe('libx264');
    expect(option(encoded(['libaom-av1'], { video: { codec: 'av1' } }), '-c:v')).toBe('libaom-av1');
    expect(
      option(encoded(['libsvtav1'], { container: 'webm', video: { codec: 'vp9' } }), '-c:v'),
    ).toBe('libsvtav1');
  });

  it('fails, naming the encoders it needs, when none is available', () => {
    expect(
      planError({ recipe: recipe({ trimStart: frames(1) }), encoders: new Set(['aac']) }),
    ).toBe(
      'Exact cuts re-encode the video, and this ffmpeg has no suitable encoder (libx264, h264_videotoolbox, h264_mf, libopenh264). Choose fast cuts, or install a complete ffmpeg build.',
    );
    expect(
      planError({
        probe: probeOf({ container: 'webm', video: { codec: 'vp9' } }),
        recipe: recipe({ trimStart: frames(1) }),
        encoders: new Set(['libx264', 'libopus']),
      }),
    ).toContain('(libvpx-vp9, libsvtav1, libaom-av1)');
    expect(
      planError({
        recipe: recipe({ audio: 'keep', trimStart: frames(1) }),
        encoders: new Set(['libx264']),
      }),
    ).toBe('This ffmpeg has no encoder for the audio (aac, aac_at, aac_mf, libfdk_aac).');
  });

  it('encodes WebM audio in Opus, converting layouts libopus refuses', () => {
    const { args } = plan({
      probe: probeOf({
        container: 'webm',
        video: { codec: 'vp9' },
        audio: [
          { index: 1, codec: 'vorbis', channels: 6, layout: '5.1(side)', startSec: 0 },
          { index: 2, codec: 'vorbis', channels: 6, layout: '5.1', startSec: 0 },
        ],
      }),
      recipe: recipe({ audio: 'keep', trimEnd: seconds(1) }),
    });
    expect(option(args, '-c:a')).toBe('libopus');
    expect(option(args, '-b:a:0')).toBe('320k');
    expect(option(args, '-filter:a:0')).toBe('aresample,aformat=channel_layouts=5.1');
    expect(option(args, '-filter:a:1')).toBeNull();
    expect(option(args, '-f')).toBe('webm');
    expect(args).not.toContain('-write_tmcd');
    const vorbis = plan({
      probe: probeOf({ container: 'webm', video: { codec: 'vp9' } }),
      recipe: recipe({ audio: 'replace', trackId: 'song', loop: false }),
      track: TRACK,
      encoders: new Set(['libvorbis']),
    });
    expect(option(vorbis.args, '-c:a')).toBe('libvorbis');
    expect(option(vorbis.args, '-filter:a:0')).toBe('apad');
  });

  it('writes .m4v with the MP4 muxer and Matroska with its own', () => {
    const muxerOf = (container: string, precision: Recipe['precision']) =>
      option(
        plan({ probe: probeOf({ container }), recipe: recipe({ precision, trimEnd: frames(1) }) })
          .args,
        '-f',
      );
    expect(muxerOf('m4v', 'exact')).toBe('mp4');
    expect(muxerOf('mov', 'exact')).toBe('mov');
    expect(muxerOf('qt', 'fast')).toBe('mov');
    expect(muxerOf('mkv', 'exact')).toBe('matroska');
    expect(muxerOf('avi', 'fast')).toBe('matroska');
    expect(muxerOf('avi', 'exact')).toBe('mp4');
  });

  it('copies subtitles the output container takes, only when it is the source container', () => {
    const subtitles = [
      { index: 2, codec: 'mov_text' },
      { index: 3, codec: 'eia_608' },
    ];
    const mp4 = plan({ probe: probeOf({ subtitles }), recipe: recipe({ audio: 'remove' }) });
    expect(options(mp4.args, '-map')).toEqual(['0:0', '0:2']);
    expect(option(mp4.args, '-c:s')).toBe('copy');
    const reencoded = plan({
      probe: probeOf({ container: 'ts', subtitles: [{ index: 2, codec: 'dvb_subtitle' }] }),
      recipe: recipe({ audio: 'remove', trimStart: frames(1) }),
    });
    expect(options(reencoded.args, '-map')).toEqual(['0:0']);
    expect(reencoded.args).not.toContain('-c:s');
  });

  it('keeps the fonts of Matroska subtitles, never other attachments', () => {
    const { args } = plan({
      probe: probeOf({ container: 'mkv', subtitles: [{ index: 2, codec: 'ass' }], fonts: [3] }),
      recipe: recipe({ audio: 'remove' }),
    });
    expect(options(args, '-map')).toEqual(['0:0', '0:2', '0:3']);
    expect(option(args, '-c:t')).toBe('copy');
    const withoutSubtitles = plan({
      probe: probeOf({ container: 'mkv', fonts: [3] }),
      recipe: recipe({ audio: 'remove' }),
    });
    expect(options(withoutSubtitles.args, '-map')).toEqual(['0:0']);
  });

  describe('in MPEG streams', () => {
    // Transport stream timestamps: audio first, video 23 ms later.
    const transport = probeOf({
      container: 'ts',
      video: { startSec: 1.466667, frameCount: null },
      audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', startSec: 1.443444 }],
      formatStartSec: 1.443444,
    });
    const at = (frame: number) => 1.466667 + frame / 30;

    it('cuts exactly by seeking the output, from the earliest stream used', () => {
      const keep = plan({
        probe: transport,
        recipe: recipe({ audio: 'keep', trimStart: frames(10), trimEnd: seconds(0.5) }),
        totalFrames: 90,
      });
      expect(keep.args.slice(0, 2)).toEqual(['-i', '/videos/clip.mp4']);
      expect(options(keep.args, '-ss')).toEqual([(at(10) - 0.002 - 1.443444).toFixed(6)]);
      expect(option(keep.args, '-frames:v')).toBeNull();
      expect(option(keep.args, '-t')).toBe((65 / 30 - 0.002).toFixed(6));
      expect(option(keep.args, '-f')).toBe('mp4');
      // Without its audio, the timeline starts with the video.
      const remove = plan({ probe: transport, recipe: recipe({ trimStart: frames(10) }) });
      expect(options(remove.args, '-ss')).toEqual([(10 / 30 - 0.002).toFixed(6)]);
    });

    it('shifts a new soundtrack by the output seek', () => {
      const { args } = plan({
        probe: transport,
        recipe: recipe({ audio: 'replace', trackId: 'song', trimStart: frames(10) }),
        track: TRACK,
      });
      const track = args.indexOf(TRACK.path);
      expect(args.slice(track - 5, track + 1)).toEqual([
        ...['-itsoffset', (10 / 30 - 0.002).toFixed(6), '-stream_loop', '2', '-i'],
        TRACK.path,
      ]);
    });

    it('copies from just before the keyframe is decoded', () => {
      const { args, durationSec } = plan({
        probe: transport,
        recipe: recipe({ audio: 'keep', precision: 'fast', trimStart: frames(20) }),
        keyframe: { ptsSec: at(15), dtsSec: at(13) },
      });
      expect(args.slice(0, 2)).toEqual(['-i', '/videos/clip.mp4']);
      expect(options(args, '-ss')).toEqual([(at(13) - 0.002 - 1.443444).toFixed(6)]);
      expect(option(args, '-avoid_negative_ts')).toBe('make_zero');
      expect(option(args, '-t')).toBeNull();
      expect(durationSec).toBeCloseTo(3 - 0.5, 9);
      // From the first keyframe: nothing to drop.
      const first = plan({
        probe: transport,
        recipe: recipe({ audio: 'keep', precision: 'fast', trimStart: frames(5) }),
        keyframe: { ptsSec: at(0), dtsSec: at(-2) },
      });
      expect(options(first.args, '-ss')).toEqual([]);
    });

    it('counts the length from the first stream used when not seeking', () => {
      const end = at(83);
      const withoutAudio = plan({
        probe: transport,
        recipe: recipe({ audio: 'remove', trimEnd: frames(7) }),
        totalFrames: 90,
      });
      expect(option(withoutAudio.args, '-t')).toBe((end - 1.466667).toFixed(6));
      const withAudio = plan({
        probe: transport,
        recipe: recipe({ audio: 'keep', trimEnd: frames(7) }),
        totalFrames: 90,
      });
      // With audio, the length alone ends the video, a margin before the first frame removed.
      expect(option(withAudio.args, '-t')).toBe((end - 0.002 - 1.443444).toFixed(6));
      // Other containers count from the format start, whatever is used.
      const mp4 = plan({
        probe: probeOf({ video: { startSec: 0.1 } }),
        recipe: recipe({ audio: 'remove', trimEnd: frames(7) }),
      });
      expect(option(mp4.args, '-t')).toBe((0.1 + 83 / 30).toFixed(6));
    });
  });

  describe('silencing', () => {
    /** The fades that mute the audio before `untilSec` and after `fromSec`, on the filters' time line. */
    const fades = (untilSec: number | null, fromSec: number | null) =>
      [
        ...(untilSec === null ? [] : [`afade=t=in:st=${untilSec.toFixed(6)}:d=0.005`]),
        ...(fromSec === null ? [] : [`afade=t=out:st=${(fromSec - 0.005).toFixed(6)}:d=0.005`]),
      ].join(',');

    it('mutes the audio alone, encoding it and copying the video', () => {
      const { args } = plan({
        recipe: recipe({ audio: 'keep', silenceStart: seconds(1), silenceEnd: frames(15) }),
      });
      expect(args).toEqual([
        ...['-i', '/videos/clip.mp4', '-map', '0:0', '-map', '0:1'],
        ...['-map_metadata', '0', '-map_chapters', '0', '-dn', '-c:v', 'copy'],
        ...['-c:a', 'aac', '-b:a:0', '192k', '-filter:a:0', fades(1, 2.5)],
        ...['-write_tmcd', '0', '-f', 'mp4', '/videos/.clip.partial-1234abcd.mp4'],
      ]);
      // Whatever the precision: nothing is cut.
      expect(
        plan({
          recipe: recipe({ audio: 'keep', precision: 'fast', silenceStart: seconds(1) }),
        }).args,
      ).toContain(fades(1, null));
    });

    it('counts from the first frame and to the end of the last, on the format time line', () => {
      // Matroska encoded with AAC: the file starts at -0.021 s, the video at 0.021 s.
      const { args } = plan({
        probe: probeOf({ container: 'mkv', video: { startSec: 0.021 }, formatStartSec: -0.021 }),
        recipe: recipe({ audio: 'keep', silenceStart: frames(3), silenceEnd: seconds(1) }),
      });
      expect(option(args, '-filter:a:0')).toBe(fades(0.042 + 0.1, 0.042 + 2));
    });

    it('counts from the first frame an exact cut keeps, the time line starting at the seek', () => {
      const { args } = plan({
        recipe: recipe({
          audio: 'keep',
          trimStart: frames(30),
          trimEnd: frames(15),
          silenceStart: frames(10),
          silenceEnd: seconds(0.5),
        }),
      });
      // Seeking 2 ms before frame 30, whose time is the start of the filters' time line.
      expect(option(args, '-ss')).toBe('0.998000');
      expect(option(args, '-filter:a:0')).toBe(fades(0.002 + 10 / 30, 0.002 + 1.5 - 0.5));
      expect(option(args, '-c:v')).toBe('libx264');
    });

    it('counts from the keyframe a fast cut starts at, where the time line starts', () => {
      const { args } = plan({
        recipe: recipe({
          audio: 'keep',
          precision: 'fast',
          trimStart: frames(20),
          silenceStart: seconds(0.25),
          silenceEnd: frames(30),
        }),
        keyframe: { ptsSec: 0.5, dtsSec: 0.5 - 2 / 30 },
      });
      expect(option(args, '-c:v')).toBe('copy');
      expect(option(args, '-c:a')).toBe('aac');
      expect(option(args, '-filter:a:0')).toBe(fades(0.25, 2.5 - 1));
    });

    it('mutes a new soundtrack, which starts at 0 on the time line, before padding it', () => {
      const { args } = plan({
        recipe: recipe({
          audio: 'replace',
          trackId: 'song',
          trimStart: frames(30),
          silenceEnd: seconds(1),
        }),
        track: TRACK,
      });
      expect(option(args, '-filter:a:0')).toBe(`${fades(null, 0.002 + 1)},apad`);
    });

    it('goes by the time line before the output seek in MPEG streams', () => {
      // Audio first, at 1.443 s; the video 23 ms later.
      const transport = probeOf({
        container: 'ts',
        video: { startSec: 1.466667 },
        audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', startSec: 1.443444 }],
        formatStartSec: 1.443444,
      });
      const exact = plan({
        probe: transport,
        recipe: recipe({ audio: 'keep', trimStart: frames(10), silenceStart: frames(10) }),
      });
      expect(option(exact.args, '-filter:a:0')).toBe(fades(1.466667 + 20 / 30 - 1.443444, null));
      const fast = plan({
        probe: transport,
        recipe: recipe({
          audio: 'replace',
          trackId: 'song',
          precision: 'fast',
          trimStart: frames(20),
          silenceStart: seconds(0.5),
        }),
        track: TRACK,
        keyframe: { ptsSec: 1.466667 + 0.5, dtsSec: 1.466667 + 13 / 30 },
      });
      // The source's audio is not used: the time line starts with the video. The soundtrack is
      // shifted by the output seek, onto that time line too.
      expect(option(fast.args, '-filter:a:0')).toBe(`${fades(0.5 + 0.5, null)},apad`);
    });

    it('silences frames at the times scanned', () => {
      // 30 fps for 2 s, then 2 fps: the last 2 frames show from 3 s, frame 10 at 1/3 s.
      const times = [...Array.from({ length: 60 }, (_, index) => index / 30), ...[2, 2.5, 3, 3.5]];
      const { args } = plan({
        probe: probeOf({ video: { durationSec: 4, frameRate: 16, frameCount: 64 } }),
        recipe: recipe({ audio: 'keep', silenceStart: frames(10), silenceEnd: frames(2) }),
        frameTimes: { times, complete: true },
      });
      expect(option(args, '-filter:a:0')).toBe(fades(10 / 30, 3));
      // On the frame rate's grid without them.
      const grid = plan({
        probe: probeOf({ video: { durationSec: 4, frameRate: 16, frameCount: 64 } }),
        recipe: recipe({ audio: 'keep', silenceStart: frames(10), silenceEnd: frames(2) }),
      });
      expect(option(grid.args, '-filter:a:0')).toBe(fades(10 / 16, 4 - 2 / 16));
    });

    it('mutes every audio stream kept', () => {
      const { args } = plan({
        probe: probeOf({
          container: 'mkv',
          audio: [
            { index: 1, codec: 'aac', channels: 2, layout: 'stereo', startSec: 0 },
            { index: 2, codec: 'ac3', channels: 6, layout: '5.1(side)', startSec: 0.5 },
          ],
        }),
        recipe: recipe({ audio: 'keep', silenceStart: seconds(1) }),
      });
      expect(option(args, '-filter:a:0')).toBe(fades(1, null));
      expect(option(args, '-filter:a:1')).toBe(fades(1, null));
    });

    it('counts from the first frame shown, when looked up', () => {
      // A copy of a capture whose first frames do not decode: its first keyframe shows at 0.2 s.
      const { args } = plan({
        recipe: recipe({ audio: 'keep', silenceStart: seconds(0.5) }),
        firstFrameSec: 0.2,
      });
      expect(option(args, '-filter:a:0')).toBe(fades(0.7, null));
    });

    it('starts the time line of MPEG streams where ffmpeg does: at the streams they hold', () => {
      // The first frame decoded comes 0.2 s after the video stream starts; an undecodable audio
      // stream, left out, starts earlier still.
      const capture = probeOf({
        container: 'ts',
        video: { startSec: 1.621333, streamStartSec: 1.421333 },
        audio: [
          { index: 1, codec: 'aac', channels: 2, layout: 'stereo', startSec: 1.5 },
          { index: 2, codec: null, channels: 2, layout: null, startSec: 1 },
        ],
        formatStartSec: 1,
      });
      const { args } = plan({
        probe: capture,
        recipe: recipe({ audio: 'keep', trimEnd: frames(5), silenceStart: seconds(0.3) }),
        totalFrames: 75,
      });
      expect(option(args, '-filter:a:0')).toBe(fades(1.621333 + 0.3 - 1.421333, null));
      expect(option(args, '-t')).toBe((1.621333 + 70 / 30 - 0.002 - 1.421333).toFixed(6));
    });

    it('ends the result after the last frame scanned, where the container says it ends before', () => {
      // 30 fps for 2 s, then 2 fps: the stream says it lasts 2.6 s, its frames show until 4 s.
      const times = [...Array.from({ length: 60 }, (_, index) => index / 30), ...[2, 2.5, 3, 3.5]];
      const vfr = probeOf({ video: { durationSec: 2.6, frameRate: 24.6, frameCount: 64 } });
      const end = plan({
        probe: vfr,
        recipe: recipe({ audio: 'keep', silenceEnd: frames(2) }),
        frameTimes: { times, complete: true },
      });
      expect(option(end.args, '-filter:a:0')).toBe(fades(null, 3));
      // Only the first frames scanned, up to frame 62: the result still lasts that long at least.
      const start = plan({
        probe: vfr,
        recipe: recipe({ audio: 'keep', silenceStart: frames(62) }),
        frameTimes: { times: times.slice(0, 63), complete: false },
      });
      expect(option(start.args, '-filter:a:0')).toBe(fades(3, null));
      // Past the last frame, the silence covers it all.
      expect(
        planError({
          probe: vfr,
          recipe: recipe({ audio: 'keep', silenceStart: frames(64) }),
          frameTimes: { times, complete: true },
        }),
      ).toBe('The silences cover all of it (0:04 long): remove the audio instead.');
    });

    it('refuses silences that leave no sound, in frames or seconds', () => {
      expect(
        planError({
          recipe: recipe({ audio: 'keep', silenceStart: frames(45), silenceEnd: seconds(1.5) }),
        }),
      ).toBe('The silences cover all of it (0:03 long): remove the audio instead.');
      expect(
        planError({
          recipe: recipe({ audio: 'keep', trimEnd: frames(30), silenceStart: seconds(2) }),
        }),
      ).toBe('The silences cover all of it (0:02 long once trimmed): remove the audio instead.');
      // Half a frame of sound is enough.
      expect(plan({ recipe: recipe({ audio: 'keep', silenceStart: frames(89) }) }).args).toContain(
        fades(89 / 30, null),
      );
    });

    it('needs the frame rate for silences in frames', () => {
      expect(
        planError({
          probe: probeOf({ video: { frameRate: null } }),
          recipe: recipe({ audio: 'keep', silenceEnd: frames(3) }),
        }),
      ).toBe('Its frame rate is unknown: silence it in seconds.');
      expect(
        plan({
          probe: probeOf({ video: { frameRate: null } }),
          recipe: recipe({ audio: 'keep', silenceEnd: seconds(1) }),
        }).args,
      ).toContain(fades(null, 2));
    });

    it('says before the run when no audio can be silenced, as none of it decodes', () => {
      const undecodable = probeOf({
        audio: [{ index: 1, codec: null, channels: 4, layout: null, startSec: 0 }],
      });
      const silence = recipe({ audio: 'keep', silenceEnd: seconds(1) });
      expect(silencedAudioIssue(silence, undecodable)).toBe(
        'Its audio cannot be decoded, so it cannot be silenced.',
      );
      expect(silencedAudioIssue({ ...silence, audio: 'replace' }, undecodable)).toBeNull();
      expect(silencedAudioIssue(silence, probeOf())).toBeNull();
      expect(silencedAudioIssue(silence, probeOf({ audio: [] }))).toBeNull();
    });

    it('leaves out audio that ffmpeg cannot decode, even from MOV, which would keep it', () => {
      const audio = [
        { index: 1, codec: 'aac', channels: 2, layout: 'stereo', startSec: 0 },
        { index: 2, codec: null, channels: 4, layout: null, startSec: 0 },
      ] as const;
      const { args, droppedAudio } = plan({
        probe: probeOf({ container: 'mov', audio }),
        recipe: recipe({ audio: 'keep', silenceEnd: seconds(1) }),
      });
      expect(options(args, '-map')).toEqual(['0:0', '0:1']);
      expect(droppedAudio).toEqual([2]);
      expect(
        planError({
          probe: probeOf({ container: 'mov', audio: [audio[1]] }),
          recipe: recipe({ audio: 'keep', trimStart: frames(1), silenceEnd: seconds(1) }),
        }),
      ).toBe('Its audio cannot be decoded, so it cannot be silenced.');
    });

    it('does nothing for a removed audio', () => {
      const { args } = plan({
        recipe: recipe({ audio: 'remove', silenceStart: seconds(1), silenceEnd: seconds(5) }),
      });
      expect(args).toContain('-an');
      expect(args.some((arg) => arg.includes('afade'))).toBe(false);
    });
  });

  it('maps the video stream by index, whatever comes before it', () => {
    const { args } = plan({
      probe: probeOf({
        video: { index: 2 },
        audio: [{ index: 0, codec: 'aac', channels: 2, layout: 'stereo', startSec: 0 }],
      }),
      recipe: recipe({ audio: 'keep', trimEnd: frames(1) }),
    });
    expect(options(args, '-map')).toEqual(['0:2', '0:0']);
  });
});

describe('framesToScan and keyframeLookup', () => {
  it('scans every frame for an end trim in frames, the first ones for a start trim', () => {
    const mkv = probeOf({ container: 'mkv', video: { frameCount: null } });
    expect(framesToScan(recipe({ trimEnd: frames(3) }), mkv)).toBe('all');
    // Even when the container records a count: it may count frames that never show.
    expect(framesToScan(recipe({ trimEnd: frames(3) }), probeOf())).toBe('all');
    expect(framesToScan(recipe({ trimStart: frames(3), trimEnd: seconds(1) }), mkv)).toBe(4);
    expect(framesToScan(recipe({ precision: 'fast', trimStart: frames(3) }), mkv)).toBe(4);
    expect(framesToScan(recipe({ trimStart: seconds(3), trimEnd: seconds(3) }), mkv)).toBeNull();
    // Trims in frames are refused when the frame rate is unknown.
    expect(
      framesToScan(recipe({ trimEnd: frames(3) }), probeOf({ video: { frameRate: null } })),
    ).toBeNull();
  });

  it('scans the frames that silences in frames last, and those before them', () => {
    const keep = { audio: 'keep' } as const;
    expect(framesToScan(recipe({ ...keep, silenceEnd: frames(3) }), probeOf())).toBe('all');
    expect(framesToScan(recipe({ ...keep, silenceStart: frames(3) }), probeOf())).toBe(4);
    expect(
      framesToScan(recipe({ ...keep, trimStart: frames(5), silenceStart: frames(3) }), probeOf()),
    ).toBe(9);
    // A start trim in seconds does not tell which frame is the first one kept.
    expect(
      framesToScan(recipe({ ...keep, trimStart: seconds(1), silenceStart: frames(3) }), probeOf()),
    ).toBe('all');
    expect(framesToScan(recipe({ ...keep, silenceStart: seconds(3) }), probeOf())).toBeNull();
    // Unused for a removed audio.
    expect(framesToScan(recipe({ audio: 'remove', silenceEnd: frames(3) }), probeOf())).toBeNull();
  });

  it('looks for the keyframe before the time the first frame kept shows', () => {
    const times = [0, 0.1, 0.5, 0.6, 2, 2.1];
    expect(
      keyframeLookup(recipe({ precision: 'fast', trimStart: frames(4) }), probeOf(), {
        times,
        complete: true,
      }),
    ).toBeCloseTo(2.002, 9);
  });

  it('looks for a keyframe only for fast start cuts, a margin past the cut', () => {
    expect(keyframeLookup(recipe({ precision: 'fast', trimStart: frames(15) }), probeOf())).toBe(
      0.5 + 0.002,
    );
    expect(
      keyframeLookup(recipe({ precision: 'exact', trimStart: frames(15) }), probeOf()),
    ).toBeNull();
    expect(
      keyframeLookup(recipe({ precision: 'fast', trimEnd: frames(15) }), probeOf()),
    ).toBeNull();
    // The start does not need the frame count, which only the end uses.
    expect(
      keyframeLookup(
        recipe({ precision: 'fast', trimStart: seconds(1), trimEnd: frames(2) }),
        probeOf({ video: { frameCount: null } }),
      ),
    ).toBeCloseTo(1.002, 9);
  });
});
