import { execTool } from './exec';
import type { MediaTools } from './media-tools';

const WIDTH = 320;
const HEIGHT = 180;
const TIMEOUT_MS = 30_000;

/**
 * A JPEG still ~10% into the video, past black intros (the first frame as a fallback), scaled to
 * fit 320×180 with its display aspect ratio and rotation applied. Rejects when no frame can be
 * decoded.
 */
export async function renderThumbnail(
  tools: MediaTools,
  file: string,
  durationSec: number | null,
): Promise<Uint8Array> {
  const seekSec = durationSec !== null && durationSec > 0 ? durationSec * 0.1 : 0;
  const frame = await grabFrame(tools.ffmpeg, file, seekSec).catch(() => null);
  if (frame !== null) {
    return frame;
  }
  if (seekSec > 0) {
    return grabFrame(tools.ffmpeg, file, 0);
  }
  throw new Error('No frame of this video can be decoded.');
}

async function grabFrame(ffmpeg: string, file: string, seekSec: number): Promise<Uint8Array> {
  const { stdout } = await execTool(
    ffmpeg,
    [
      ...['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', seekSec.toFixed(3), '-i', file],
      // `V`: a video stream that is not cover art. ffmpeg rotates frames as the file says.
      ...['-map', '0:V:0', '-frames:v', '1', '-an', '-sn', '-dn'],
      // Square pixels first, so that anamorphic videos keep their shape.
      ...['-vf', `scale=iw*sar:ih,scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease`],
      ...['-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1'],
    ],
    { timeoutMs: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
  );
  if (stdout.length === 0) {
    throw new Error('ffmpeg produced no frame.');
  }
  return stdout;
}
