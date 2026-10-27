/**
 * Real ffmpeg for integration tests. The one under test is the one the app would find, so
 * `VIDEO_TOOL_FFMPEG_DIR` tests another version. The same one makes the clips and measures the
 * results, unless `VIDEO_TOOL_FIXTURE_FFMPEG_DIR` names another: a current version, to test an
 * old one on the same clips, measured the same way. With ffmpeg 4.4 alone, two tests fail for its
 * own sake: it moves the first frame of an MP4 remuxed to Matroska, and its ffprobe reads no field
 * order from H.264. The tests are skipped when ffmpeg is not installed, unless
 * `VIDEO_TOOL_REQUIRE_FFMPEG=1` (CI), where a missing ffmpeg fails them instead.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { execTool } from '../exec';
import type { MediaTools } from '../media-tools';
import { fpsModeArgs, loadMediaTools, loadMediaToolsIn } from '../media-tools';

const tools = await loadMediaTools(null);
const fixtureDir = process.env['VIDEO_TOOL_FIXTURE_FFMPEG_DIR'] ?? '';
const fixtureTools = fixtureDir === '' ? tools : await loadMediaToolsIn([fixtureDir]);

/** For `describe.skipIf`. */
export const ffmpegMissing =
  (tools === null || fixtureTools === null) && process.env['VIDEO_TOOL_REQUIRE_FFMPEG'] !== '1';

/** Whether the ffmpeg that makes the clips has an encoder, for clips that most builds cannot make. */
export function hasEncoder(name: string): boolean {
  return fixtureTools?.encoders.has(name) ?? false;
}

/** The ffmpeg under test. */
export function requireTools(): MediaTools {
  if (tools === null) {
    throw new Error('ffmpeg and ffprobe are required (VIDEO_TOOL_REQUIRE_FFMPEG=1) but not found.');
  }
  return tools;
}

/** The ffmpeg that makes the clips and measures the results. */
function instruments(): MediaTools {
  if (fixtureTools === null) {
    throw new Error(`No ffmpeg and ffprobe in VIDEO_TOOL_FIXTURE_FFMPEG_DIR (${fixtureDir}).`);
  }
  return fixtureTools;
}

/** `-fps_mode:v <mode>`, as the ffmpeg that makes the clips spells it (`-vsync` before 5.1). */
export function fpsMode(mode: 'passthrough' | 'vfr'): readonly string[] {
  return fpsModeArgs(instruments().features, mode);
}

/** Frame k has luma 16 + 2k, so that the frames a cut keeps can be told from the picture. */
export function rampSource(seconds: number, fps = 30, size = '320x240'): string {
  return `color=c=black:s=${size}:r=${fps}:d=${seconds},format=yuv420p,geq=lum='16+2*N':cb=128:cr=128`;
}

export function toneSource(seconds: number, frequency = 440): string {
  return `sine=frequency=${frequency}:sample_rate=48000:duration=${seconds}`;
}

/** Runs ffmpeg quietly, failing with its stderr. */
export async function ffmpeg(args: readonly string[]): Promise<string> {
  const { stderr } = await execTool(
    instruments().ffmpeg,
    ['-hide_banner', '-nostdin', '-y', ...args],
    { timeoutMs: 120_000, maxBuffer: 64 * 1024 * 1024 },
  ).catch((error: unknown) => {
    throw new Error(`ffmpeg ${args.join(' ')} failed: ${String(error)}`, { cause: error });
  });
  return stderr;
}

export async function ffprobeJson(args: readonly string[]): Promise<unknown> {
  const { stdout } = await execTool(
    instruments().ffprobe,
    ['-v', 'error', '-print_format', 'json', ...args],
    { timeoutMs: 60_000, maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout.toString('utf8')) as unknown;
}

export interface StreamSummary {
  readonly index: number;
  readonly type: string;
  readonly codec: string;
  readonly startSec: number | null;
  readonly durationSec: number | null;
}

/** The streams of a file, with durations as the container records them. */
export async function streamsOf(file: string): Promise<StreamSummary[]> {
  const json = (await ffprobeJson(['-show_streams', file])) as {
    streams?: {
      index: number;
      codec_type: string;
      codec_name?: string;
      start_time?: string;
      duration?: string;
      tags?: { DURATION?: string };
    }[];
  };
  return (json.streams ?? []).map((stream) => ({
    index: stream.index,
    type: stream.codec_type,
    codec: stream.codec_name ?? '',
    startSec: stream.start_time === undefined ? null : Number(stream.start_time),
    durationSec: durationOf(stream.duration, stream.tags?.DURATION),
  }));
}

function durationOf(duration: string | undefined, tag: string | undefined): number | null {
  if (duration !== undefined && Number.isFinite(Number(duration))) {
    return Number(duration);
  }
  const clock = tag === undefined ? null : /^(\d+):(\d+):([\d.]+)$/.exec(tag);
  return clock ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) : null;
}

/** Frames of the first video stream, decoded and counted. */
export async function countDecodedFrames(file: string): Promise<number> {
  const json = (await ffprobeJson([
    ...['-count_frames', '-select_streams', 'V:0', '-show_entries', 'stream=nb_read_frames', file],
  ])) as { streams?: { nb_read_frames?: string }[] };
  return Number(json.streams?.[0]?.nb_read_frames);
}

/** Mean luma of each decoded frame of the first video stream, in decoding order. */
export async function frameLumas(file: string): Promise<number[]> {
  const width = 32;
  const height = 24;
  const { stdout } = await execTool(
    instruments().ffmpeg,
    [
      ...['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, '-map', '0:V:0'],
      // Every frame as decoded (no rate conversion), luma plane only, as stored: the same range in
      // and out, as ffmpeg 6.1 would take gray for full range and expand limited-range luma.
      ...fpsMode('passthrough'),
      ...['-vf', `extractplanes=y,scale=${width}:${height}:flags=area:in_range=tv:out_range=tv`],
      ...['-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
    ],
    { timeoutMs: 60_000, maxBuffer: 256 * 1024 * 1024 },
  );
  const size = width * height;
  const lumas: number[] = [];
  for (let offset = 0; offset + size <= stdout.length; offset += size) {
    let sum = 0;
    for (let index = offset; index < offset + size; index++) {
      sum += stdout[index] ?? 0;
    }
    lumas.push(sum / size);
  }
  return lumas;
}

/** Mean volume in dB of the first audio stream from `fromSec` on; about -91 for digital silence. */
export async function meanVolume(file: string, fromSec: number): Promise<number> {
  const stderr = await ffmpeg([
    ...['-ss', String(fromSec), '-i', file, '-map', '0:a:0', '-af', 'volumedetect'],
    ...['-f', 'null', '-'],
  ]);
  const match = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr);
  if (match?.[1] === undefined) {
    throw new Error(`No volume measured in ${file}`);
  }
  return match[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(match[1]);
}

export interface Span {
  readonly startSec: number;
  readonly endSec: number;
}

/**
 * From the first packet of the first video or audio stream to the end of its last one, on the
 * file's time line: what a player shows, or plays, encoder delays included.
 */
export async function packetSpan(file: string, stream: 'v' | 'a'): Promise<Span> {
  const { stdout } = await execTool(
    instruments().ffprobe,
    [
      ...['-v', 'error', '-select_streams', `${stream}:0`],
      ...['-show_entries', 'packet=pts_time,duration_time', '-print_format', 'csv=p=0', file],
    ],
    { timeoutMs: 60_000, maxBuffer: 64 * 1024 * 1024 },
  );
  // `N/A` when unknown.
  const packets = stdout
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => line.trim().split(',').map(Number))
    .flatMap(([pts, duration]) =>
      pts !== undefined && Number.isFinite(pts)
        ? [{ pts, end: pts + (duration !== undefined && Number.isFinite(duration) ? duration : 0) }]
        : [],
    );
  if (packets.length === 0) {
    throw new Error(`No timed packets in stream ${stream} of ${file}`);
  }
  return {
    startSec: Math.min(...packets.map(({ pts }) => pts)),
    endSec: Math.max(...packets.map(({ end }) => end)),
  };
}

/** A time as ffmpeg prints it: `1.5`, `-0.021`, or `3.125e-05` up to ffmpeg 6.1. */
const TIME = String.raw`-?\d+(?:\.\d+)?(?:e[-+]?\d+)?`;

/**
 * When the first audio stream starts to be heard, on the file's time line: after the silence that
 * encoders put first (AAC primes its decoder with 1024 samples), for a sound that starts at once.
 */
export async function audibleStart(file: string): Promise<number> {
  const stderr = await ffmpeg([
    ...['-copyts', '-i', file, '-map', '0:a:0'],
    ...['-af', 'silencedetect=noise=-50dB:duration=0.001', '-f', 'null', '-'],
  ]);
  // As decoded: MP4 edit lists, and Matroska's codec delay since ffmpeg 9.0, have the decoder skip
  // the samples that prime it, in the first packets.
  const json = (await ffprobeJson([
    ...['-select_streams', 'a:0', '-read_intervals', '%+#8'],
    ...['-show_entries', 'frame=best_effort_timestamp_time', file],
  ])) as { frames?: { best_effort_timestamp_time?: string }[] };
  const start = Math.min(
    ...(json.frames ?? [])
      .map((frame) => Number(frame.best_effort_timestamp_time))
      .filter((time) => Number.isFinite(time)),
  );
  const silence = new RegExp(`silence_start: (${TIME})[\\s\\S]*?silence_end: (${TIME})`, 'i').exec(
    stderr,
  );
  // Silent from the start: heard where that silence ends.
  return silence !== null && Math.abs(Number(silence[1]) - start) < 0.002
    ? Number(silence[2])
    : start;
}

/**
 * Makes an AAC track of an MP4 or MOV file one that ffmpeg cannot decode, like the spatial audio
 * (APAC) of recent iPhones: renames its sample entry (`mp4a`, also inside MOV's `wave`) to `apac`
 * and its decoder configuration (`esds`). `track` counts the file's tracks from 0.
 */
export async function disguiseAudioTrack(file: string, track: number): Promise<void> {
  const data = await readFile(file);
  const boxes = (start: number, end: number) => {
    const found: { readonly start: number; readonly end: number; readonly type: string }[] = [];
    for (let at = start; at + 8 <= end;) {
      const size = data.readUInt32BE(at);
      found.push({ start: at, end: at + size, type: data.toString('latin1', at + 4, at + 8) });
      at += Math.max(size, 8);
    }
    return found;
  };
  const moov = boxes(0, data.length).find((box) => box.type === 'moov');
  const trak = moov && boxes(moov.start + 8, moov.end).filter((box) => box.type === 'trak')[track];
  if (trak === undefined) {
    throw new Error(`No track ${String(track)} in ${file}`);
  }
  const region = data.subarray(trak.start, trak.end);
  for (const [from, to] of [
    ['mp4a', 'apac'],
    ['esds', 'esdx'],
  ] as const) {
    for (
      let at = region.indexOf(from, 0, 'latin1');
      at !== -1;
      at = region.indexOf(from, at, 'latin1')
    ) {
      region.write(to, at, 'latin1');
    }
  }
  await writeFile(file, data);
}

/** MD5 of every video packet, as stored: equal for a stream copy, different once re-encoded. */
export async function videoPacketHashes(file: string): Promise<string[]> {
  const { stdout } = await execTool(
    instruments().ffmpeg,
    [
      ...['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, '-map', '0:V:0'],
      ...['-c', 'copy', '-f', 'framemd5', 'pipe:1'],
    ],
    { timeoutMs: 60_000, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.split(',').at(-1)?.trim() ?? '');
}

/**
 * From the first frame of a video or audio stream (the first by default), as decoded, to the end of
 * its last one, on the file's time line: what is shown or heard, decoders' skipped samples left out.
 */
export async function decodedSpan(file: string, stream: 'v' | 'a', index = 0): Promise<Span> {
  const json = (await ffprobeJson([
    ...['-select_streams', `${stream}:${String(index)}`],
    // `pkt_duration_time` before ffmpeg 5.0.
    ...['-show_entries', 'frame=best_effort_timestamp_time,duration_time,pkt_duration_time', file],
  ])) as {
    frames?: {
      best_effort_timestamp_time?: string;
      duration_time?: string;
      pkt_duration_time?: string;
    }[];
  };
  const frames = (json.frames ?? []).flatMap((frame) => {
    const time = Number(frame.best_effort_timestamp_time);
    const duration = Number(frame.duration_time ?? frame.pkt_duration_time);
    return Number.isFinite(time)
      ? [{ time, end: time + (Number.isFinite(duration) ? duration : 0) }]
      : [];
  });
  if (frames.length === 0) {
    throw new Error(`No decoded frames in stream ${stream} of ${file}`);
  }
  return {
    startSec: Math.min(...frames.map(({ time }) => time)),
    endSec: Math.max(...frames.map(({ end }) => end)),
  };
}

/**
 * Where an audio stream (the first by default) is silent, on the file's time line: from where its
 * sound stops, or where the stream starts, to where it is heard again, or where the stream ends.
 * For a sound that never stops by itself, like a tone.
 */
export async function silentSpans(file: string, index = 0): Promise<Span[]> {
  const stderr = await ffmpeg([
    ...['-copyts', '-i', file, '-map', `0:a:${String(index)}`],
    ...['-af', 'silencedetect=noise=-50dB:duration=0.001', '-f', 'null', '-'],
  ]);
  const spans: Span[] = [];
  for (const match of stderr.matchAll(new RegExp(`silence_(start|end): (${TIME})`, 'gi'))) {
    const time = Number(match[2]);
    if (match[1] === 'start') {
      spans.push({ startSec: time, endSec: Number.POSITIVE_INFINITY });
    } else if (spans.length > 0 && spans.at(-1)?.endSec === Number.POSITIVE_INFINITY) {
      spans[spans.length - 1] = { startSec: spans.at(-1)?.startSec ?? time, endSec: time };
    }
  }
  return spans;
}
