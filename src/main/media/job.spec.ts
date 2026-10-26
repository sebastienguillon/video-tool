import type { OutputSettings, Recipe } from '@shared/model';
import { DEFAULT_RECIPE } from '@shared/model';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { destinationOf, JobError, processVideo } from './job';
import { firstFrame, probeVideo } from './probe';
import type { Progress } from './runner';
import { CanceledError } from './runner';
import {
  audibleStart,
  countDecodedFrames,
  disguiseAudioTrack,
  ffmpeg,
  ffmpegMissing,
  ffprobeJson,
  fpsMode,
  frameLumas,
  hasEncoder,
  meanVolume,
  packetSpan,
  rampSource,
  requireTools,
  streamsOf,
  toneSource,
  videoPacketHashes,
} from './testing/fixtures';

const BESIDE: OutputSettings = { location: 'beside', folder: null };

const seconds = (amount: number) => ({ amount, unit: 'seconds' }) as const;
const frames = (amount: number) => ({ amount, unit: 'frames' }) as const;

describe('destinationOf', () => {
  it('puts results beside the source, or in the chosen folder', () => {
    const source = path.resolve('videos', 'clip.mp4');
    expect(destinationOf(source, BESIDE)).toBe(path.dirname(source));
    expect(destinationOf(source, { location: 'folder', folder: null })).toBe(path.dirname(source));
    expect(destinationOf(source, { location: 'folder', folder: 'out' })).toBe(path.resolve('out'));
  });
});

describe.skipIf(ffmpegMissing)('processVideo', () => {
  let dir: string;
  /** Hash and mtime of every source, checked again at the end. */
  const sources = new Map<string, { readonly hash: string; readonly mtimeMs: number }>();
  const file = (...names: string[]) => path.join(dir, ...names);

  async function fingerprint(target: string) {
    return {
      hash: createHash('sha256')
        .update(await readFile(target))
        .digest('hex'),
      mtimeMs: (await stat(target)).mtimeMs,
    };
  }

  /** A 3 s, 30 fps clip whose frame k has luma 16 + 2k, keyframes every 15 frames, with a tone. */
  async function ramp(name: string, options: readonly string[] = [], fps = 30): Promise<void> {
    await ffmpeg([
      ...['-loglevel', 'error', '-f', 'lavfi', '-i', rampSource(3, fps)],
      ...['-f', 'lavfi', '-i', toneSource(3), '-g', '15', ...options, file(name)],
    ]);
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'video-tool-job-'));
    const h264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac'];
    await Promise.all([
      ramp('ramp.mp4', h264),
      // Without an edit list, B-frames delay the video: it starts at 0.067 s, the audio at 0.
      ramp('delayed.mp4', [...h264, '-use_editlist', '0']),
      // Encoded straight to Matroska, the AAC codec delay starts the file at -0.021 s.
      ramp('early.mkv', h264),
      ramp('ntsc.mp4', h264, 30000 / 1001),
      // MPEG streams: no index, and timestamps starting at 1.4 s.
      ramp('transport.ts', h264),
      ramp('program.mpg', ['-c:v', 'mpeg2video', '-q:v', '2', '-c:a', 'mp2']),
      // AVI stores no presentation times: with B-frames, the first frame shows 2 frames late.
      ramp('bframes.avi', ['-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'libmp3lame']),
      ramp('ramp.flv', h264),
      ramp('ramp.webm', [
        ...['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M'],
        ...['-c:a', 'libopus'],
      ]),
      ffmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', toneSource(1, 1000), file('tone1.m4a')]),
      ffmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', toneSource(5, 1000), file('tone5.mp3')]),
      // AAC stores 5.1(side) with its own channel map, which ffmpeg reads back in no known order.
      ffmpeg([
        ...[
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          `${toneSource(2)},aformat=channel_layouts=5.1(side)`,
        ],
        file('surround.m4a'),
      ]),
      ffmpeg([
        ...['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=20'],
        ...['-c:v', 'libx264', '-preset', 'ultrafast', file('slow.mp4')],
      ]),
      // DivX style: MPEG-4 Part 2 with B-frames.
      ramp('divx.avi', ['-c:v', 'mpeg4', '-bf', '2', '-q:v', '3', '-c:a', 'libmp3lame']),
      // MPEG-2 with B-frames so small that several share a packet, and its timestamp.
      ramp('dvd.mpg', [
        ...['-c:v', 'mpeg2video', '-bf', '2', '-q:v', '2', '-sc_threshold', '1000000000'],
        ...['-c:a', 'mp2'],
      ]),
      // Variable frame rate, as phones and screen recorders make: 30 fps for 2 s, then 2 fps.
      // 64 frames, frame k with luma 16 + 2k.
      ffmpeg([
        ...['-loglevel', 'error', '-f', 'lavfi', '-i'],
        `color=c=black:s=320x240:r=30:d=4,select='lt(t\\,2)+not(mod(n\\,15))',format=yuv420p,geq=lum='16+2*N':cb=128:cr=128`,
        ...['-f', 'lavfi', '-i', toneSource(4), ...fpsMode('vfr'), '-c:v', 'libx264'],
        ...['-preset', 'veryfast', '-bf', '0', '-g', '15', '-c:a', 'aac', file('vfr.mp4')],
      ]),
      // Camera MJPEG, full range 4:2:2; QuickTime Animation, RGB.
      ffmpeg([
        ...['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=1'],
        ...['-pix_fmt', 'yuvj422p', '-c:v', 'mjpeg', '-q:v', '3', file('camera.avi')],
      ]),
      ffmpeg([
        ...['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=1'],
        ...['-c:v', 'qtrle', file('animation.mov')],
      ]),
      // Interlaced camcorder footage (AVCHD), top field first; and bottom field first.
      ...(['tff', 'bff'] as const).map((order) =>
        ffmpeg([
          ...['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=50:d=1'],
          '-vf',
          `tinterlace=interleave_${order === 'tff' ? 'top' : 'bottom'},setfield=${order}`,
          ...['-c:v', 'libx264', '-preset', 'veryfast', '-flags', '+ildct+ilme'],
          ...['-x264-params', `${order}=1`, file(order === 'tff' ? 'camcorder.m2ts' : 'bff.mkv')],
        ]),
      ),
      // A browser's MediaRecorder writes WebM without a duration.
      ffmpeg([
        ...['-loglevel', 'error', '-f', 'lavfi', '-i', rampSource(3), '-f', 'lavfi'],
        ...['-i', toneSource(3), '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '1M'],
        ...['-c:a', 'libopus', '-f', 'webm', '-live', '1', file('recorded.webm')],
      ]),
      // Two AAC tracks, the second to be made undecodable.
      ...['spatial.mov', 'spatial.mp4'].map((name) =>
        ffmpeg([
          ...['-loglevel', 'error', '-f', 'lavfi', '-i', rampSource(3), '-f', 'lavfi'],
          ...['-i', toneSource(3), '-f', 'lavfi', '-i', toneSource(3, 880)],
          ...['-map', '0', '-map', '1', '-map', '2', '-g', '15', '-c:v', 'libx264'],
          ...['-preset', 'veryfast', '-c:a', 'aac', file(name)],
        ]),
      ),
    ]);
    await Promise.all([
      // Remuxed to Matroska: the video now starts at 0.021 s, and no frame count is recorded.
      ffmpeg(['-loglevel', 'error', '-i', file('ramp.mp4'), '-c', 'copy', file('remuxed.mkv')]),
      ffmpeg(['-loglevel', 'error', '-i', file('vfr.mp4'), '-c', 'copy', file('vfr.mkv')]),
      // Cut without re-encoding, 5 frames past the keyframe at 0.5 s: an edit list hides frames 15
      // to 19, which MP4 still counts.
      ffmpeg([
        ...['-loglevel', 'error', '-ss', String(20 / 30), '-i', file('ramp.mp4')],
        ...['-c', 'copy', file('edited.mp4')],
      ]),
      // Like the spatial audio (APAC) of recent iPhones.
      disguiseAudioTrack(file('spatial.mov'), 2),
      disguiseAudioTrack(file('spatial.mp4'), 2),
    ]);
    await mkdir(file('dossier é 日本'));
    await copyFile(file('ramp.mp4'), file('dossier é 日本', 'clip été.mp4'));
    for (const name of await readdir(dir, { recursive: true })) {
      const target = file(name);
      if ((await stat(target)).isFile()) {
        sources.set(target, await fingerprint(target));
      }
    }
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  interface RunOptions {
    readonly output?: OutputSettings;
    readonly track?: string;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: Progress) => void;
  }

  async function run(source: string, recipe: Partial<Recipe>, options: RunOptions = {}) {
    const tools = requireTools();
    return processVideo({
      tools,
      source,
      probe: await probeVideo(tools, source),
      recipe: { ...DEFAULT_RECIPE, ...recipe },
      output: options.output ?? BESIDE,
      track:
        options.track === undefined
          ? null
          : { path: options.track, suffix: path.parse(options.track).name },
      signal: options.signal ?? new AbortController().signal,
      onProgress: options.onProgress ?? (() => undefined),
    });
  }

  async function audioOf(output: string) {
    const audio = (await streamsOf(output)).filter((stream) => stream.type === 'audio');
    expect(audio).toHaveLength(1);
    return audio[0]!;
  }

  /** Frame k of the ramp has luma 16 + 2k; lossy encoding moves flat frames by less than 1. */
  async function expectFrames(output: string, first: number, last: number): Promise<void> {
    const lumas = await frameLumas(output);
    expect(lumas).toHaveLength(last - first + 1);
    expect(lumas[0]).toBeCloseTo(16 + 2 * first, -0.3);
    expect(lumas.at(-1)).toBeCloseTo(16 + 2 * last, -0.3);
    expect(await countDecodedFrames(output)).toBe(last - first + 1);
  }

  it.each([
    ['ramp.mp4', 'mp4'],
    ['delayed.mp4', 'mp4'],
    ['early.mkv', 'mkv'],
    ['remuxed.mkv', 'mkv'],
    ['ntsc.mp4', 'mp4'],
    ['ramp.webm', 'webm'],
    ['transport.ts', 'mp4'],
    ['program.mpg', 'mp4'],
    ['bframes.avi', 'mp4'],
  ])('cuts exactly the frames asked from %s', async (name, extension) => {
    const progress: Progress[] = [];
    const output = await run(
      file(name),
      { audio: 'keep', precision: 'exact', trimStart: frames(10), trimEnd: frames(5) },
      { onProgress: (report) => progress.push(report) },
    );
    expect(path.basename(output)).toBe(`${path.parse(name).name} (trimmed).${extension}`);
    await expectFrames(output, 10, 84);
    const fps = name === 'ntsc.mp4' ? 30000 / 1001 : 30;
    expect((await audioOf(output)).durationSec).toBeCloseTo(75 / fps, 1);
    expect(progress.at(-1)?.progress).toBe(1);
  });

  it.each([
    'ramp.mp4',
    'delayed.mp4',
    'early.mkv',
    'remuxed.mkv',
    'ntsc.mp4',
    'ramp.webm',
    'transport.ts',
    'program.mpg',
    'bframes.avi',
  ])('cuts seconds on the frames they fall on from %s', async (name) => {
    const fps = name === 'ntsc.mp4' ? 30000 / 1001 : 30;
    const { video } = await probeVideo(requireTools(), file(name));
    const output = await run(file(name), {
      audio: 'keep',
      precision: 'exact',
      trimStart: seconds(10 / fps),
      trimEnd: seconds(5 / fps),
    });
    // The end is a time before the end of the stream, as long as the container says it lasts.
    const end = Math.min(90, Math.ceil((video.durationSec - 5 / fps) * fps - 1e-3));
    await expectFrames(output, 10, end - 1);
  });

  it('cuts MPEG streams exactly past their first keyframe, whatever streams are used', async () => {
    // Keyframes every 15 frames: the seek lands on frame 15, and decoding goes on to frame 20.
    const cut = await run(file('transport.ts'), {
      audio: 'remove',
      precision: 'exact',
      trimStart: frames(20),
      trimEnd: frames(7),
    });
    await expectFrames(cut, 20, 82);
    const soundtrack = await run(
      file('transport.ts'),
      { audio: 'replace', trackId: 'tone', loop: true, precision: 'exact', trimStart: frames(20) },
      { track: file('tone5.mp3') },
    );
    await expectFrames(soundtrack, 20, 89);
    expect(Math.abs(((await audioOf(soundtrack)).durationSec ?? 0) - 70 / 30)).toBeLessThan(0.03);
    // The new soundtrack starts with the video, not 0.6 s into itself.
    expect(await meanVolume(soundtrack, 0)).toBeGreaterThan(-40);
    const fast = await run(file('transport.ts'), {
      audio: 'keep',
      precision: 'fast',
      trimStart: frames(20),
    });
    expect(path.basename(fast)).toBe('transport (trimmed).mkv');
    expect((await frameLumas(fast))[0]).toBeCloseTo(16 + 2 * 15, -0.3);
  });

  it('cuts in seconds on frame boundaries', async () => {
    const output = await run(file('ramp.mp4'), {
      audio: 'remove',
      precision: 'exact',
      trimStart: seconds(0.5),
      trimEnd: seconds(1),
    });
    expect(path.basename(output)).toBe('ramp (no audio, trimmed).mp4');
    await expectFrames(output, 15, 59);
    expect((await streamsOf(output)).map((stream) => stream.type)).toEqual(['video']);
  });

  describe('with a variable frame rate', () => {
    it.each(['vfr.mp4', 'vfr.mkv'])('cuts the frames asked from %s', async (name) => {
      // On the average frame rate's grid (18 fps), frame 10 would be at 0.55 s: frame 16.
      const output = await run(file(name), {
        audio: 'keep',
        precision: 'exact',
        trimStart: frames(10),
        trimEnd: frames(2),
      });
      await expectFrames(output, 10, 61);
      // From frame 10 to frame 62, at 3 s.
      expect((await audioOf(output)).durationSec).toBeCloseTo(3 - 10 / 30, 1);
    });

    it('cuts seconds where they fall, not after as many frames at the average rate', async () => {
      // The last second goes: the video ends with the frame at 2.5 s. 46 frames at the average
      // rate would end it at 1.5 s.
      const output = await run(file('vfr.mp4'), {
        audio: 'keep',
        precision: 'exact',
        trimEnd: seconds(1),
      });
      await expectFrames(output, 0, 61);
      expect((await audioOf(output)).durationSec).toBeCloseTo(2.53, 1);
    });

    it('starts a fast cut at the keyframe before the frame asked', async () => {
      const output = await run(file('vfr.mp4'), {
        audio: 'keep',
        precision: 'fast',
        trimStart: frames(20),
      });
      // Keyframes every 15 frames: frame 20 shows at 0.67 s, after the keyframe at 0.5 s.
      const lumas = await frameLumas(output);
      expect(lumas[0]).toBeCloseTo(16 + 2 * 15, -0.3);
      expect(lumas).toHaveLength(64 - 15);
    });
  });

  it('counts only the frames an edit list shows', async () => {
    // edited.mp4 shows frames 20 to 89 of the ramp; MP4 counts the 5 it hides before them too.
    const output = await run(file('edited.mp4'), {
      audio: 'remove',
      precision: 'exact',
      trimEnd: frames(5),
    });
    await expectFrames(output, 20, 84);
  });

  describe('copying AVI and MPEG program streams', () => {
    it('removes the audio of videos with B-frames', async () => {
      for (const name of ['bframes.avi', 'divx.avi', 'dvd.mpg']) {
        const output = await run(file(name), { audio: 'remove' });
        expect(path.basename(output)).toBe(`${path.parse(name).name} (no audio).mkv`);
        await expectFrames(output, 0, 89);
      }
    });

    it('cuts a program stream fast from the keyframe before the cut', async () => {
      const output = await run(file('dvd.mpg'), {
        audio: 'keep',
        precision: 'fast',
        trimStart: frames(20),
      });
      await expectFrames(output, 15, 89);
    });

    it('replaces their audio', async () => {
      const output = await run(
        file('bframes.avi'),
        { audio: 'replace', trackId: 'tone', loop: true },
        { track: file('tone1.m4a') },
      );
      await expectFrames(output, 0, 89);
      // To the end of the last frame, which the copy shows a frame after its decoding time.
      const end = (await packetSpan(output, 'a')).endSec - (await packetSpan(output, 'v')).endSec;
      expect(Math.abs(end)).toBeLessThan(1024 / 48_000);
    });

    it('cuts them fast', async () => {
      // The keyframe before frame 35 is frame 30, though ffmpeg seeks AVI 3/23 s early.
      const start = await run(file('bframes.avi'), {
        audio: 'keep',
        precision: 'fast',
        trimStart: frames(35),
      });
      await expectFrames(start, 30, 89);
      const end = await run(file('bframes.avi'), {
        audio: 'keep',
        precision: 'fast',
        trimEnd: frames(10),
      });
      const lumas = await frameLumas(end);
      expect(lumas[0]).toBeCloseTo(16, -0.3);
      // A copy cuts in decoding order: a few frames late at most.
      expect(lumas.length).toBeGreaterThanOrEqual(80);
      expect(lumas.length).toBeLessThanOrEqual(84);
      expect(await countDecodedFrames(end)).toBe(lumas.length);
    });

    it.skipIf(!hasEncoder('libxvid'))('unpacks the B-frames of Xvid and DivX', async () => {
      await ramp('xvid.avi', ['-c:v', 'libxvid', '-bf', '2', '-q:v', '3', '-c:a', 'libmp3lame']);
      const output = await run(file('xvid.avi'), { audio: 'remove' });
      // The decoder says so when it meets them.
      const notices = (video: string) => ffmpeg(['-v', 'info', '-i', video, '-f', 'null', '-']);
      expect(await notices(file('xvid.avi'))).toContain('packed B-frames');
      expect(await notices(output)).not.toContain('packed B-frames');
      expect(await countDecodedFrames(output)).toBe(await countDecodedFrames(file('xvid.avi')));
    });
  });

  describe('with audio that ffmpeg cannot decode', () => {
    /** The sample entries of the audio tracks: ffprobe 9.0 names APAC, which others do not. */
    async function audioTags(output: string) {
      const json = (await ffprobeJson(['-show_streams', '-select_streams', 'a', output])) as {
        streams: { codec_tag_string: string }[];
      };
      return json.streams.map((stream) => stream.codec_tag_string);
    }

    it('keeps it in MOV, copied, while the rest is cut exactly', async () => {
      const output = await run(file('spatial.mov'), {
        audio: 'keep',
        precision: 'exact',
        trimStart: frames(10),
      });
      await expectFrames(output, 10, 89);
      expect(await audioTags(output)).toEqual(['mp4a', 'apac']);
    });

    it('leaves it out of MP4, which cannot hold it', async () => {
      const exact = await run(file('spatial.mp4'), {
        audio: 'keep',
        precision: 'exact',
        trimStart: frames(10),
      });
      expect(await audioTags(exact)).toEqual(['mp4a']);
      const fast = await run(file('spatial.mp4'), {
        audio: 'keep',
        precision: 'fast',
        trimEnd: seconds(1),
      });
      expect(await audioTags(fast)).toEqual(['mp4a']);
    });
  });

  it('makes H.264 that plays everywhere from MJPEG and RGB sources', async () => {
    const formatOf = async (output: string) => {
      const json = (await ffprobeJson(['-show_streams', '-select_streams', 'v', output])) as {
        streams: { codec_name: string; profile: string; pix_fmt: string; color_range?: string }[];
      };
      return json.streams[0];
    };
    const camera = await run(file('camera.avi'), { precision: 'exact', trimStart: frames(5) });
    // Full range stays full range.
    expect(await formatOf(camera)).toMatchObject({
      codec_name: 'h264',
      profile: 'High',
      pix_fmt: 'yuvj420p',
      color_range: 'pc',
    });
    const animation = await run(file('animation.mov'), { precision: 'exact', trimEnd: frames(5) });
    expect(path.extname(animation)).toBe('.mov');
    expect(await formatOf(animation)).toMatchObject({ profile: 'High', pix_fmt: 'yuv420p' });
  });

  it('keeps interlaced video interlaced, in its field order', async () => {
    const fieldOrderOf = async (output: string) => {
      const json = (await ffprobeJson(['-show_streams', '-select_streams', 'v', output])) as {
        streams: { field_order?: string }[];
      };
      return json.streams[0]?.field_order;
    };
    const top = await run(file('camcorder.m2ts'), { precision: 'exact', trimStart: frames(5) });
    expect(await fieldOrderOf(top)).toBe('tt');
    expect(await countDecodedFrames(top)).toBe(20);
    // ffmpeg tags bottom-first H.264 in Matroska `bt`: the frames tell.
    const tools = requireTools();
    const bottom = await run(file('bff.mkv'), { precision: 'exact', trimEnd: frames(5) });
    const { video } = await probeVideo(tools, bottom);
    expect(video.fieldOrder).toBe('bff');
    expect((await firstFrame(tools, bottom, video.index))?.fieldOrder).toBe('bff');
  });

  it('processes a WebM that records no duration', async () => {
    const removed = await run(file('recorded.webm'), { audio: 'remove' });
    expect(path.basename(removed)).toBe('recorded (no audio).webm');
    expect(await countDecodedFrames(removed)).toBe(90);
    const cut = await run(file('recorded.webm'), {
      audio: 'keep',
      precision: 'exact',
      trimEnd: seconds(1),
    });
    await expectFrames(cut, 0, 59);
  });

  it('removes the audio without touching the video packets', async () => {
    const output = await run(file('dossier é 日本', 'clip été.mp4'), { audio: 'remove' });
    expect(output).toBe(file('dossier é 日本', 'clip été (no audio).mp4'));
    expect((await streamsOf(output)).map((stream) => stream.type)).toEqual(['video']);
    expect(await videoPacketHashes(output)).toEqual(
      await videoPacketHashes(file('dossier é 日本', 'clip été.mp4')),
    );
  });

  it('numbers the results rather than replacing one', async () => {
    const first = await run(file('ramp.mp4'), { audio: 'remove' });
    const second = await run(file('ramp.mp4'), { audio: 'remove' });
    expect(path.basename(first)).toBe('ramp (no audio).mp4');
    expect(path.basename(second)).toBe('ramp (no audio) 2.mp4');
  });

  it('loops a short soundtrack to the end of the video', async () => {
    const output = await run(
      file('ramp.mp4'),
      { audio: 'replace', trackId: 'tone', loop: true },
      { track: file('tone1.m4a') },
    );
    expect(path.basename(output)).toBe('ramp (tone1).mp4');
    expect((await audioOf(output)).durationSec).toBeCloseTo(3, 1);
    expect(Math.abs(((await audioOf(output)).durationSec ?? 0) - 3)).toBeLessThan(0.025);
    expect(await meanVolume(output, 2)).toBeGreaterThan(-40);
    expect(await videoPacketHashes(output)).toEqual(await videoPacketHashes(file('ramp.mp4')));
  });

  it('pads a short soundtrack with silence when it does not loop', async () => {
    const output = await run(
      file('ramp.mp4'),
      { audio: 'replace', trackId: 'tone', loop: false },
      { track: file('tone1.m4a') },
    );
    expect(Math.abs(((await audioOf(output)).durationSec ?? 0) - 3)).toBeLessThan(0.025);
    expect(await meanVolume(output, 0.2)).toBeGreaterThan(-40);
    expect(await meanVolume(output, 1.5)).toBeLessThan(-80);
  });

  it('cuts a long soundtrack at the end of the video', async () => {
    const output = await run(
      file('ramp.mp4'),
      { audio: 'replace', trackId: 'tone', loop: true },
      { track: file('tone5.mp3') },
    );
    expect(Math.abs(((await audioOf(output)).durationSec ?? 0) - 3)).toBeLessThan(0.025);
  });

  it('takes a soundtrack whose channel order is unknown', async () => {
    const output = await run(
      file('ramp.mp4'),
      { audio: 'replace', trackId: 'surround', loop: true },
      { track: file('surround.m4a') },
    );
    const json = (await ffprobeJson(['-show_streams', '-select_streams', 'a', output])) as {
      streams: { channels: number; channel_layout: string }[];
    };
    expect(json.streams[0]).toMatchObject({ channels: 6, channel_layout: '5.1' });
  });

  it('fast cuts copy the video from the keyframe before the cut', async () => {
    const output = await run(file('ramp.mp4'), {
      audio: 'keep',
      precision: 'fast',
      trimStart: frames(20),
      trimEnd: frames(5),
    });
    const lumas = await frameLumas(output);
    // Keyframes every 15 frames: the copy starts at frame 15. It ends near frame 84, a few frames
    // late at most: a copy cuts in decoding order, where B-frames come after the next P-frame.
    expect(lumas[0]).toBeCloseTo(16 + 2 * 15, -0.3);
    expect(lumas.length).toBeGreaterThanOrEqual(84 - 15 + 1);
    expect(lumas.length).toBeLessThanOrEqual(84 - 15 + 1 + 4);
    const source = new Set(await videoPacketHashes(file('ramp.mp4')));
    expect((await videoPacketHashes(output)).every((hash) => source.has(hash))).toBe(true);
  });

  describe('cutting fast', () => {
    // Matroska, WebM and AVI, where ffmpeg seeks 3/23 s early when a stream has B-frames (WebM's
    // VP9 has none), and MP4, where it does not.
    // FLV too: its streams record no duration, and the file's counts the video's start (67 ms) twice.
    const names = ['ramp.mp4', 'remuxed.mkv', 'early.mkv', 'ramp.webm', 'bframes.avi', 'ramp.flv'];

    it.each(names)('copies %s from the keyframe before the cut', async (name) => {
      // Keyframes every 15 frames: frame 30 for a cut at frame 35.
      const output = await run(file(name), {
        audio: 'keep',
        precision: 'fast',
        trimStart: frames(35),
      });
      await expectFrames(output, 30, 89);
    });

    it.each(names)('starts a new soundtrack with the first frame of %s', async (name) => {
      const output = await run(
        file(name),
        { audio: 'replace', trackId: 'tone', precision: 'fast', trimStart: frames(35) },
        { track: file('tone5.mp3') },
      );
      await expectFrames(output, 30, 89);
      // The soundtrack is heard from the first frame to the end of the last, within an audio frame:
      // 1024 samples of AAC at 48 kHz, more than the 960 of Opus.
      const audioFrame = 1024 / 48_000;
      const video = await packetSpan(output, 'v');
      expect(Math.abs((await audibleStart(output)) - video.startSec)).toBeLessThan(audioFrame);
      expect(Math.abs((await packetSpan(output, 'a')).endSec - video.endSec)).toBeLessThan(
        audioFrame,
      );
      expect(video.endSec - video.startSec).toBeCloseTo(2, 2);
    });
  });

  it('writes to the chosen folder, which must exist', async () => {
    const folder = file('results');
    await mkdir(folder);
    const output = await run(
      file('ramp.mp4'),
      { audio: 'remove' },
      { output: { location: 'folder', folder } },
    );
    expect(output).toBe(path.join(folder, 'ramp (no audio).mp4'));
    await expect(
      run(
        file('ramp.mp4'),
        { audio: 'remove' },
        { output: { location: 'folder', folder: file('gone') } },
      ),
    ).rejects.toThrow(new JobError(`The output folder ${file('gone')} does not exist.`));
  });

  it('refuses cuts that would leave nothing, and missing sources', async () => {
    await expect(
      run(file('ramp.mp4'), { trimStart: frames(60), trimEnd: frames(30) }),
    ).rejects.toThrow('The trims remove all of it (0:03 long).');
    const tools = requireTools();
    const probe = await probeVideo(tools, file('ramp.mp4'));
    await expect(
      processVideo({
        tools,
        source: file('vanished.mp4'),
        probe,
        recipe: { ...DEFAULT_RECIPE, audio: 'remove' },
        output: BESIDE,
        track: null,
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    ).rejects.toThrow('The video was moved or deleted.');
  });

  it('refuses a soundtrack that is gone or is not audio', async () => {
    const recipe = { audio: 'replace', trackId: 'tone' } as const;
    await expect(run(file('ramp.mp4'), recipe, { track: file('gone.mp3') })).rejects.toThrow(
      'gone.mp3 is missing: it was moved or deleted.',
    );
    await expect(run(file('ramp.mp4'), recipe, { track: file('slow.mp4') })).rejects.toThrow(
      'slow.mp4 cannot be used as the new audio. No audio stream: this is not an audio file.',
    );
  });

  it('cancels mid-run, deleting the partial file', async () => {
    const controller = new AbortController();
    const before = await readdir(dir);
    const job = run(
      file('slow.mp4'),
      { audio: 'remove', precision: 'exact', trimStart: frames(1) },
      { signal: controller.signal, onProgress: () => controller.abort() },
    );
    await expect(job).rejects.toThrow(CanceledError);
    expect(await readdir(dir)).toEqual(before);
  });

  it('leaves every source untouched', async () => {
    for (const [source, original] of sources) {
      expect(await fingerprint(source), source).toEqual(original);
    }
    const partials = (await readdir(dir, { recursive: true })).filter((name) =>
      name.includes('.partial-'),
    );
    expect(partials).toEqual([]);
  });
});
