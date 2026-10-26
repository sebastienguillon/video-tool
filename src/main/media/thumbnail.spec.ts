import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderThumbnail } from './thumbnail';
import {
  ffmpeg,
  ffmpegMissing,
  ffprobeJson,
  frameLumas,
  requireTools,
  toneSource,
} from './testing/fixtures';

describe.skipIf(ffmpegMissing)('renderThumbnail', () => {
  let dir: string;
  const file = (name: string) => path.join(dir, name);

  let stills = 0;

  async function save(jpeg: Uint8Array): Promise<string> {
    const target = file(`still-${String(++stills)}.jpg`);
    await writeFile(target, jpeg);
    return target;
  }

  /** Width and height of a JPEG. */
  async function sizeOf(jpeg: Uint8Array): Promise<{ width: number; height: number }> {
    const json = (await ffprobeJson(['-show_streams', await save(jpeg)])) as {
      streams: { width: number; height: number }[];
    };
    const [stream] = json.streams;
    return { width: stream?.width ?? 0, height: stream?.height ?? 0 };
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'video-tool-thumbnail-'));
    // Anamorphic DVD-like frames (720×480 shown as 16:9), black for its first 10%.
    await ffmpeg([
      ...['-loglevel', 'error', '-f', 'lavfi', '-i'],
      "color=c=black:s=720x480:r=30:d=4,geq=lum='if(lt(N,12),16,200)':cb=128:cr=128,setsar=32/27",
      ...['-c:v', 'libx264', '-preset', 'ultrafast', file('wide.mp4')],
    ]);
    // Shot sideways. ffmpeg 5.1 and older take the rotation as a tag of the stream.
    await ffmpeg([
      ...['-loglevel', 'error', '-display_rotation', '90', '-i', file('wide.mp4')],
      ...['-c', 'copy', file('sideways.mp4')],
    ]).catch(() =>
      ffmpeg([
        ...['-loglevel', 'error', '-i', file('wide.mp4'), '-metadata:s:v:0', 'rotate=90'],
        ...['-c', 'copy', file('sideways.mp4')],
      ]),
    );
    await ffmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', toneSource(1), file('tone.m4a')]);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('renders a JPEG from 10% in, fitting 320×180 with the display aspect ratio', async () => {
    const jpeg = await renderThumbnail(requireTools(), file('wide.mp4'), 4);
    expect([...jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect(await sizeOf(jpeg)).toEqual({ width: 320, height: 180 });
    // Past the black intro.
    const [luma] = await frameLumas(await save(jpeg));
    expect(luma).toBeGreaterThan(150);
  });

  it('applies the rotation', async () => {
    const { width, height } = await sizeOf(
      await renderThumbnail(requireTools(), file('sideways.mp4'), 4),
    );
    expect(height).toBe(180);
    expect(width).toBeLessThan(height);
  });

  it('falls back on the first frame when the duration is wrong', async () => {
    const jpeg = await renderThumbnail(requireTools(), file('wide.mp4'), 400);
    expect(jpeg.length).toBeGreaterThan(0);
  });

  it('rejects files without a frame', async () => {
    await expect(renderThumbnail(requireTools(), file('tone.m4a'), 1)).rejects.toThrow();
    await expect(renderThumbnail(requireTools(), file('missing.mp4'), null)).rejects.toThrow();
  });
});
