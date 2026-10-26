import { link, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execTool } from './exec';
import {
  isSupported,
  loadMediaTools,
  parseDecodable,
  parseEncoders,
  parseVersion,
} from './media-tools';
import { ffmpegMissing, requireTools } from './testing/fixtures';

describe('parseVersion', () => {
  it('reads the version from the first line', () => {
    expect(
      parseVersion(
        'ffmpeg version 7.1-full_build-www.gyan.dev Copyright (c) 2000-2024 the FFmpeg developers\r\nbuilt with gcc',
      ),
    ).toBe('7.1-full_build-www.gyan.dev');
    expect(parseVersion('ffmpeg version n6.1.1 Copyright')).toBe('n6.1.1');
    expect(parseVersion('something else\n')).toBe('something else');
    expect(parseVersion('')).toBe('unknown');
  });
});

describe('parseEncoders', () => {
  it('reads the names in the encoder table, not the legend', () => {
    const output = [
      'Encoders:',
      ' V..... = Video',
      ' A..... = Audio',
      ' .F.... = Frame-level multithreading',
      ' ------',
      ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC (codec h264)',
      ' V..... libsvtav1            SVT-AV1 encoder (codec av1)',
      ' A..X.D opus                 Opus',
      ' A....D aac                  AAC (Advanced Audio Coding)',
      ' S..... mov_text             3GPP Timed Text subtitle',
    ].join('\r\n');
    expect([...parseEncoders(output)]).toEqual(['libx264', 'libsvtav1', 'opus', 'aac', 'mov_text']);
  });
});

describe('parseDecodable', () => {
  it('reads the codecs that can be decoded, not the legend', () => {
    const output = [
      'Codecs:',
      ' D..... = Decoding supported',
      ' .E.... = Encoding supported',
      ' -------',
      ' DEV.LS h264                 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10',
      ' DEA.L. aac                  AAC (Advanced Audio Coding) (decoders: aac aac_fixed)',
      ' ..A.L. apple_apac           Apple Positional Audio Codec',
      ' .EV.L. a64_multi            Multicolor charset for Commodore 64',
      ' D.S... hdmv_pgs_subtitle    HDMV Presentation Graphic Stream subtitles',
    ].join('\r\n');
    expect([...parseDecodable(output)]).toEqual(['h264', 'aac', 'hdmv_pgs_subtitle']);
  });
});

describe.skipIf(ffmpegMissing)('loadMediaTools', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('finds ffmpeg and ffprobe, and what they can encode', async () => {
    const found = requireTools();
    const tools = await loadMediaTools(null);
    expect(tools?.ffmpeg).toBe(found.ffmpeg);
    expect(tools?.version).not.toBe('unknown');
    expect(tools?.encoders.has('aac')).toBe(true);
    expect(tools?.decodable.has('aac')).toBe(true);
  });

  it('spells the options exact cuts need as this version does, the current names first', async () => {
    const tools = requireTools();
    const { demuxTimeBase, fpsMode } = tools.features;
    expect(isSupported(tools)).toBe(true);
    const accepts = (args: readonly string[]) =>
      execTool(
        tools.ffmpeg,
        [
          ...['-hide_banner', '-nostdin', '-loglevel', 'error'],
          ...['-f', 'lavfi', '-i', 'color=s=16x16:r=10:d=0.1', ...args, '-f', 'null', '-'],
        ],
        { timeoutMs: 15_000 },
      ).then(
        () => true,
        () => false,
      );
    expect(
      await accepts(['-enc_time_base:v', demuxTimeBase ?? '', fpsMode ?? '', 'passthrough']),
    ).toBe(true);
    // The older spellings only when the current ones are missing (before ffmpeg 6.1 and 5.1).
    expect(await accepts(['-enc_time_base:v', 'demux'])).toBe(demuxTimeBase === 'demux');
    expect(await accepts(['-fps_mode:v', 'passthrough'])).toBe(fpsMode === '-fps_mode:v');
  });

  it('looks in VIDEO_TOOL_FFMPEG_DIR first', async () => {
    const found = requireTools();
    vi.stubEnv('PATH', '');
    vi.stubEnv('VIDEO_TOOL_FFMPEG_DIR', path.dirname(found.ffmpeg));
    expect((await loadMediaTools(null))?.ffmpeg).toBe(found.ffmpeg);
  });

  it('prefers the binaries bundled in the resources over the PATH', async (context) => {
    const found = requireTools();
    vi.stubEnv('VIDEO_TOOL_FFMPEG_DIR', '');
    const resources = await mkdtemp(path.join(os.tmpdir(), 'video-tool-resources-'));
    dirs.push(resources);
    await mkdir(path.join(resources, 'bin'));
    try {
      for (const tool of [found.ffmpeg, found.ffprobe]) {
        await link(tool, path.join(resources, 'bin', path.basename(tool)));
      }
    } catch {
      context.skip('Cannot link ffmpeg into a temporary folder (another drive)');
    }
    const tools = await loadMediaTools(resources);
    expect(tools?.ffmpeg).toBe(path.join(resources, 'bin', path.basename(found.ffmpeg)));
  });

  it.skipIf(process.platform !== 'win32')('resolves to null when they are nowhere', async () => {
    vi.stubEnv('VIDEO_TOOL_FFMPEG_DIR', '');
    vi.stubEnv('PATH', '');
    expect(await loadMediaTools(null)).toBeNull();
  });
});
