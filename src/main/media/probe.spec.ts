import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findKeyframe,
  firstFrame,
  frameRateOf,
  lastKeyframe,
  lastPacketEnd,
  parseAudioProbe,
  parseFrameListing,
  parseVideoProbe,
  probeAudio,
  probeVideo,
  scanFrames,
  UnsupportedMediaError,
} from './probe';
import { ffmpeg, ffmpegMissing, rampSource, requireTools, toneSource } from './testing/fixtures';

const VIDEO = {
  index: 0,
  codec_name: 'h264',
  codec_type: 'video',
  width: 1920,
  height: 1080,
  pix_fmt: 'yuv420p',
  r_frame_rate: '30/1',
  avg_frame_rate: '30/1',
  start_time: '0.033333',
  duration: '10.000000',
  nb_frames: '300',
  bit_rate: '5000000',
  disposition: { attached_pic: 0 },
};

const AUDIO = {
  index: 1,
  codec_name: 'aac',
  codec_type: 'audio',
  channels: 6,
  channel_layout: '5.1(side)',
  duration: '10.0',
};

const FORMAT = { start_time: '-0.021333', duration: '10.021333', bit_rate: '5200000' };

describe('parseVideoProbe', () => {
  it('reads the video, audio and subtitle streams', () => {
    const probe = parseVideoProbe(
      {
        streams: [
          VIDEO,
          AUDIO,
          { index: 2, codec_name: 'mov_text', codec_type: 'subtitle' },
          { index: 3, codec_type: 'data', codec_tag_string: 'tmcd' },
        ],
        format: FORMAT,
      },
      'C:\\Vidéos\\Été 日本.MP4',
      123_456,
    );
    expect(probe.info).toEqual({
      durationSec: 10,
      width: 1920,
      height: 1080,
      frameRate: 30,
      frameCount: 300,
      videoCodec: 'h264',
      audioCodec: 'aac',
      container: 'mp4',
      sizeBytes: 123_456,
    });
    expect(probe.video).toEqual({
      index: 0,
      codec: 'h264',
      pixFmt: 'yuv420p',
      fullRange: false,
      startSec: 0.033333,
      durationSec: 10,
      frameRate: 30,
      frameCount: 300,
      bitRate: 5_000_000,
      rotation: 0,
      fieldOrder: null,
    });
    expect(probe.audio).toEqual([
      { index: 1, codec: 'aac', channels: 6, layout: '5.1(side)', startSec: null },
    ]);
    expect(probe.subtitles).toEqual([{ index: 2, codec: 'mov_text' }]);
    expect(probe.formatStartSec).toBe(-0.021333);
    expect(probe.formatBitRate).toBe(5_200_000);
    expect(probe.bFrames).toBe(false);
  });

  it('tells full-range video, by its range or its pixel format', () => {
    const fullRange = (stream: object) =>
      parseVideoProbe({ streams: [{ ...VIDEO, ...stream }], format: FORMAT }, 'a.avi', 1).video
        .fullRange;
    expect(fullRange({ pix_fmt: 'yuvj422p' })).toBe(true);
    expect(fullRange({ pix_fmt: 'yuv420p', color_range: 'pc' })).toBe(true);
    expect(fullRange({ pix_fmt: 'yuv420p', color_range: 'tv' })).toBe(false);
    expect(fullRange({ pix_fmt: 'yuv420p' })).toBe(false);
  });

  it('tells when a stream has B-frames, as ffmpeg checks before seeking', () => {
    const bFrames = (...streams: object[]) =>
      parseVideoProbe({ streams, format: FORMAT }, 'a.mkv', 1).bFrames;
    expect(bFrames({ ...VIDEO, has_b_frames: 2 }, AUDIO)).toBe(true);
    expect(bFrames({ ...VIDEO, has_b_frames: 0 }, AUDIO)).toBe(false);
    // Any stream, as ffmpeg goes by all of them.
    expect(bFrames(VIDEO, { ...VIDEO, index: 2, has_b_frames: 1 })).toBe(true);
  });

  it('skips cover art, which is not a video', () => {
    const cover = {
      ...VIDEO,
      index: 0,
      codec_name: 'mjpeg',
      disposition: { attached_pic: 1 },
    };
    expect(() =>
      parseVideoProbe({ streams: [cover, { ...AUDIO, index: 1 }], format: FORMAT }, 'a.mp4', 1),
    ).toThrow(new UnsupportedMediaError('No video stream: this is not a video.'));
    const probe = parseVideoProbe(
      { streams: [cover, { ...VIDEO, index: 1 }], format: FORMAT },
      'b.mp4',
      1,
    );
    expect(probe.video.index).toBe(1);
  });

  it('swaps width and height of videos shot sideways', () => {
    const rotated = (stream: object) =>
      parseVideoProbe({ streams: [{ ...VIDEO, ...stream }], format: FORMAT }, 'a.mov', 1).info;
    expect(
      rotated({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }),
    ).toMatchObject({ width: 1080, height: 1920 });
    expect(rotated({ side_data_list: [{ rotation: 180 }] })).toMatchObject({ width: 1920 });
    expect(rotated({ tags: { rotate: '270' } })).toMatchObject({ width: 1080, height: 1920 });
  });

  it('falls back on other sources for the frame rate, the duration and the start', () => {
    const probe = parseVideoProbe(
      {
        streams: [
          {
            ...VIDEO,
            avg_frame_rate: '0/0',
            r_frame_rate: '30000/1001',
            duration: undefined,
            nb_frames: undefined,
            start_time: 'N/A',
            tags: { DURATION: '00:01:02.500000000' },
          },
        ],
        format: { start_time: '0.5', duration: '70' },
      },
      'a.mkv',
      1,
    );
    expect(probe.info.frameRate).toBeCloseTo(29.97, 3);
    expect(probe.info.frameCount).toBeNull();
    expect(probe.info.durationSec).toBe(62.5);
    expect(probe.video.startSec).toBe(0.5);
    expect(probe.info.audioCodec).toBeNull();
    // ffmpeg writes where the stream ends in the tag.
    const delayed = parseVideoProbe(
      {
        streams: [
          {
            ...VIDEO,
            duration: undefined,
            start_time: '0.021',
            tags: { DURATION: '00:00:03.021' },
          },
        ],
        format: { duration: '3.021' },
      },
      'a.mkv',
      1,
    );
    expect(delayed.info.durationSec).toBeCloseTo(3, 9);
    const formatOnly = parseVideoProbe(
      { streams: [{ ...VIDEO, duration: 'N/A' }], format: { duration: '4.2' } },
      'a.avi',
      1,
    );
    expect(formatOnly.info.durationSec).toBe(4.2);
    expect(formatOnly.formatStartSec).toBe(0);
  });

  it('takes the duration from the packets when nothing records it, or refuses the video', () => {
    const live = { streams: [{ ...VIDEO, duration: undefined }], format: {} };
    expect(parseVideoProbe(live, 'a.webm', 1, 3.033333).info.durationSec).toBeCloseTo(3, 6);
    expect(() => parseVideoProbe(live, 'a.ts', 1)).toThrow(
      'Its duration is unknown: it cannot be processed.',
    );
    expect(() => parseVideoProbe(live, 'a.ts', 1, 0.01)).toThrow('Its duration is unknown');
  });

  it('distrusts a frame count that disagrees with the duration', () => {
    const counted = (nbFrames: string, duration: string) =>
      parseVideoProbe(
        { streams: [{ ...VIDEO, nb_frames: nbFrames, duration }], format: FORMAT },
        'a.mp4',
        1,
      ).info.frameCount;
    // Cut without re-encoding: the edit list hides 15 frames that MP4 still counts.
    expect(counted('90', '2.5')).toBeNull();
    expect(counted('75', '2.5')).toBe(75);
    expect(counted('300', '10.033')).toBe(300);
  });

  it('tells which field of interlaced video shows first', () => {
    const order = (field_order: string | undefined) =>
      parseVideoProbe({ streams: [{ ...VIDEO, field_order }], format: FORMAT }, 'a.mts', 1).video
        .fieldOrder;
    expect(order('tt')).toBe('tff');
    // Top stored first: files tag top-first video so as often as bottom-first.
    expect(order('tb')).toBe('tff');
    expect(order('bb')).toBe('bff');
    expect(order('bt')).toBe('bff');
    expect(order('progressive')).toBeNull();
    expect(order(undefined)).toBeNull();
  });

  it('keeps audio that ffmpeg cannot decode, without a codec', () => {
    const spatial = { index: 2, codec_type: 'audio', codec_tag_string: 'apac', channels: 4 };
    const probe = parseVideoProbe(
      { streams: [VIDEO, spatial, { ...AUDIO, index: 3 }], format: FORMAT },
      'IMG_0001.MOV',
      1,
    );
    expect(probe.audio.map((stream) => stream.codec)).toEqual([null, 'aac']);
    expect(probe.info.audioCodec).toBe('unknown');
    // ffmpeg 9.0 names APAC, which it still cannot decode.
    const named = parseVideoProbe(
      { streams: [VIDEO, { ...spatial, codec_name: 'apple_apac' }], format: FORMAT },
      'IMG_0001.MOV',
      1,
      null,
      new Set(['h264', 'aac']),
    );
    expect(named.audio.map((stream) => stream.codec)).toEqual([null]);
  });

  it('keeps Matroska font attachments, not cover images', () => {
    const probe = parseVideoProbe(
      {
        streams: [
          VIDEO,
          { index: 1, codec_type: 'attachment', tags: { mimetype: 'application/x-truetype-font' } },
          { index: 2, codec_type: 'attachment', tags: { filename: 'Title.OTF' } },
          {
            index: 3,
            codec_type: 'attachment',
            tags: { mimetype: 'image/jpeg', filename: 'cover.jpg' },
          },
        ],
        format: FORMAT,
      },
      'a.mkv',
      1,
    );
    expect(probe.fonts).toEqual([1, 2]);
  });

  it('reads garbage as no video', () => {
    expect(() => parseVideoProbe(null, 'a.mp4', 1)).toThrow('No video stream');
    expect(() => parseVideoProbe({ streams: 'x' }, 'a.mp4', 1)).toThrow('No video stream');
  });
});

describe('frameRateOf', () => {
  it('reads plausible rationals only', () => {
    expect(frameRateOf('30/1')).toBe(30);
    expect(frameRateOf('24000/1001')).toBeCloseTo(23.976, 3);
    expect(frameRateOf('0/0')).toBeNull();
    expect(frameRateOf('90000/1')).toBeNull();
    expect(frameRateOf('1/600')).toBeNull();
    expect(frameRateOf('abc')).toBeNull();
    expect(frameRateOf(30)).toBeNull();
  });
});

describe('parseAudioProbe', () => {
  it('reads the first audio stream, past cover art', () => {
    expect(
      parseAudioProbe({
        streams: [
          { ...VIDEO, disposition: { attached_pic: 1 } },
          { ...AUDIO, index: 1 },
        ],
        format: FORMAT,
      }),
    ).toEqual({ durationSec: 10, channels: 6, layout: '5.1(side)' });
    expect(
      parseAudioProbe({
        streams: [{ codec_type: 'audio', channels: 1, channel_layout: 'unknown' }],
        format: { duration: '3.5' },
      }),
    ).toEqual({ durationSec: 3.5, channels: 1, layout: null });
  });

  it('refuses files without audio or duration', () => {
    expect(() => parseAudioProbe({ streams: [VIDEO], format: FORMAT })).toThrow(
      'No audio stream: this is not an audio file.',
    );
    expect(() => parseAudioProbe({ streams: [{ codec_type: 'audio' }], format: {} })).toThrow(
      'Its duration is unknown: it cannot be used.',
    );
  });
});

describe('lastKeyframe', () => {
  it('finds the latest keyframe at or before a time, by pts or else dts', () => {
    const csv = [
      '0.000000,-0.066667,K__',
      '0.133333,-0.033333,___',
      '0.500000,0.433333,K__',
      'N/A,0.966667,K_D',
      '1.500000,1.433333,K__',
      '',
    ].join('\r\n');
    expect(lastKeyframe(csv, 0.4)).toEqual({ ptsSec: 0, dtsSec: -0.066667 });
    expect(lastKeyframe(csv, 0.5)).toEqual({ ptsSec: 0.5, dtsSec: 0.433333 });
    expect(lastKeyframe(csv, 1.2)).toEqual({ ptsSec: 0.966667, dtsSec: 0.966667 });
    expect(lastKeyframe(csv, 9)?.ptsSec).toBe(1.5);
    expect(lastKeyframe(csv, -1)).toBeNull();
    expect(lastKeyframe('', 1)).toBeNull();
  });
});

describe('parseFrameListing', () => {
  it('counts the frames shown and sorts when they show', () => {
    const csv = [
      '-0.500000,KD_',
      '-0.433333,_D_',
      '0.033333,___',
      '0.000000,K__',
      '0.100000,___',
      '0.066667,___',
      '',
    ].join('\r\n');
    expect(parseFrameListing(csv)).toEqual({
      packets: 6,
      count: 4,
      times: [0, 0.033333, 0.066667, 0.1],
    });
  });

  it('still counts frames without presentation times, telling none', () => {
    expect(parseFrameListing('N/A,K__\nN/A,___\n')).toEqual({ packets: 2, count: 2, times: null });
    expect(parseFrameListing('')).toEqual({ packets: 0, count: 0, times: [] });
  });
});

describe('lastPacketEnd', () => {
  it('finds where the last frame ends', () => {
    expect(lastPacketEnd('2.900000,0.033000\n2.967000,0.033000\n2.933000,0.033000\n')).toBeCloseTo(
      3,
      9,
    );
    expect(lastPacketEnd('1.500000,N/A\r\n')).toBe(1.5);
    expect(lastPacketEnd('N/A,N/A\n')).toBeNull();
  });
});

describe.skipIf(ffmpegMissing)('with ffprobe', () => {
  let dir: string;
  const file = (name: string) => path.join(dir, name);

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'video-tool-probe-'));
    await ffmpeg([
      ...[
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        rampSource(3),
        '-f',
        'lavfi',
        '-i',
        toneSource(3),
      ],
      ...['-c:v', 'libx264', '-preset', 'veryfast', '-g', '15', '-c:a', 'aac', file('clip.mp4')],
    ]);
    await ffmpeg(['-loglevel', 'error', '-i', file('clip.mp4'), '-c', 'copy', file('clip.mkv')]);
    await ffmpeg(['-loglevel', 'error', '-i', file('clip.mp4'), '-c', 'copy', file('clip.avi')]);
    // Cut without re-encoding, 5 frames past a keyframe: an edit list hides those 5.
    await ffmpeg([
      ...['-loglevel', 'error', '-ss', '0.666667', '-i', file('clip.mp4')],
      ...['-c', 'copy', file('edited.mp4')],
    ]);
    // As a browser's MediaRecorder writes it: no duration anywhere.
    await ffmpeg([
      ...['-loglevel', 'error', '-f', 'lavfi', '-i', rampSource(3, 30, '160x120')],
      ...['-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '500k', '-f', 'webm', '-live', '1'],
      file('recorded.webm'),
    ]);
    // Interlaced, bottom field first.
    await ffmpeg([
      ...['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=50:d=1'],
      ...['-vf', 'tinterlace=interleave_bottom,setfield=bff', '-c:v', 'libx264'],
      ...['-flags', '+ildct+ilme', '-x264-params', 'bff=1', file('interlaced.mts')],
    ]);
    await ffmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', toneSource(1), file('tone.mp3')]);
    await ffmpeg([
      ...['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1'],
      file('cover.jpg'),
    ]);
    await ffmpeg([
      ...[
        '-loglevel',
        'error',
        '-i',
        file('tone.mp3'),
        '-i',
        file('cover.jpg'),
        '-map',
        '0',
        '-map',
      ],
      ...['1', '-c', 'copy', '-disposition:v', 'attached_pic', file('song.mp3')],
    ]);
    await writeFile(file('notes.mp4'), 'not a video at all');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('probes a video', async () => {
    const probe = await probeVideo(requireTools(), file('clip.mp4'));
    expect(probe.info).toMatchObject({
      durationSec: 3,
      width: 320,
      height: 240,
      frameRate: 30,
      frameCount: 90,
      videoCodec: 'h264',
      audioCodec: 'aac',
      container: 'mp4',
    });
    expect(probe.info.sizeBytes).toBeGreaterThan(0);
  });

  it('counts the frames Matroska does not record, with when they show', async () => {
    const tools = requireTools();
    const probe = await probeVideo(tools, file('clip.mkv'));
    expect(probe.info.frameCount).toBeNull();
    expect(probe.info.durationSec).toBeCloseTo(3, 2);
    const scan = await scanFrames(tools, file('clip.mkv'), probe.video.index, null);
    expect(scan).toMatchObject({ count: 90, complete: true });
    // Matroska stores milliseconds; the video starts with the AAC delay of the MP4.
    expect(scan.times?.[10]).toBeCloseTo(probe.video.startSec + 10 / 30, 3);
  });

  it('counts only the frames an edit list shows', async () => {
    const tools = requireTools();
    const probe = await probeVideo(tools, file('edited.mp4'));
    expect(probe.info.durationSec).toBeCloseTo(70 / 30, 3);
    // MP4 records 75 frames, the 5 hidden ones included.
    expect(probe.info.frameCount).toBeNull();
    expect(await scanFrames(tools, file('edited.mp4'), 0, null)).toMatchObject({
      count: 70,
      complete: true,
    });
  });

  it('reads only the first frames when asked', async () => {
    const scan = await scanFrames(requireTools(), file('clip.mp4'), 0, 11);
    expect(scan.complete).toBe(false);
    expect(scan.count).toBeLessThan(90);
    const first = scan.times?.slice(0, 11) ?? [];
    expect(first).toHaveLength(11);
    first.forEach((time, k) => {
      expect(time).toBeCloseTo(k / 30, 5);
    });
    expect(await scanFrames(requireTools(), file('clip.mp4'), 0, 89)).toMatchObject({
      count: 90,
      complete: true,
    });
  });

  it('finds the duration of a video that does not record it', async () => {
    const probe = await probeVideo(requireTools(), file('recorded.webm'));
    expect(probe.info.durationSec).toBeCloseTo(3, 2);
    expect(probe.info.frameRate).toBe(30);
  });

  it('reads an AVI with the presentation times a stream copy works out', async () => {
    const tools = requireTools();
    // AVI keeps decoding times only; `+genpts` shows each frame when the next one is decoded.
    expect((await scanFrames(tools, file('clip.avi'), 0, 1)).times).toBeNull();
    const scan = await scanFrames(tools, file('clip.avi'), 0, 1, { genpts: true });
    expect(scan.times?.[0]).toBeCloseTo(1 / 30, 6);
    const keyframe = await findKeyframe(tools, file('clip.avi'), 0, 31 / 30 + 0.002, {
      genpts: true,
    });
    expect(keyframe?.ptsSec).toBeCloseTo(31 / 30, 6);
    expect(keyframe?.dtsSec).toBeCloseTo(1, 6);
    expect((await findKeyframe(tools, file('clip.avi'), 0, 1.002))?.ptsSec).toBeCloseTo(1, 6);
  });

  it('finds the keyframe a stream copy starts at', async () => {
    const tools = requireTools();
    expect((await findKeyframe(tools, file('clip.mp4'), 0, 20 / 30 + 0.002))?.ptsSec).toBeCloseTo(
      0.5,
      6,
    );
    expect((await findKeyframe(tools, file('clip.mp4'), 0, 0.5 + 0.002))?.ptsSec).toBeCloseTo(
      0.5,
      6,
    );
    expect((await findKeyframe(tools, file('clip.mp4'), 0, 0.4))?.ptsSec).toBe(0);
  });

  it('tells when the first frame really shows', async () => {
    const tools = requireTools();
    expect(await firstFrame(tools, file('clip.mp4'), 0)).toEqual({ startSec: 0, fieldOrder: null });
    // AVI keeps decoding times only: with B-frames, display starts two frames later.
    const avi = await probeVideo(tools, file('clip.avi'));
    expect(avi.video.startSec).toBe(0);
    expect((await firstFrame(tools, file('clip.avi'), avi.video.index))?.startSec).toBeCloseTo(
      2 / 30,
      6,
    );
  });

  it('tells which field of interlaced video shows first, from the stream and the frames', async () => {
    const tools = requireTools();
    const probe = await probeVideo(tools, file('interlaced.mts'));
    expect(probe.video.fieldOrder).toBe('bff');
    expect((await firstFrame(tools, file('interlaced.mts'), probe.video.index))?.fieldOrder).toBe(
      'bff',
    );
    expect((await probeVideo(tools, file('clip.mp4'))).video.fieldOrder).toBeNull();
  });

  it('rejects what is not a video with a message for the user', async () => {
    const tools = requireTools();
    await expect(probeVideo(tools, file('song.mp3'))).rejects.toThrow(
      'No video stream: this is not a video.',
    );
    await expect(probeVideo(tools, file('notes.mp4'))).rejects.toThrow(
      'This file cannot be read: it may be damaged, or not a video.',
    );
    await expect(probeVideo(tools, file('gone.mp4'))).rejects.toThrow(
      'This file was moved or deleted.',
    );
  });

  it('reads the duration of a soundtrack', async () => {
    const tools = requireTools();
    const { durationSec } = await probeAudio(tools, file('song.mp3'));
    expect(durationSec).toBeCloseTo(1, 1);
    await expect(probeAudio(tools, file('notes.mp4'))).rejects.toThrow(
      'This file cannot be read as audio.',
    );
  });
});
