import { createLogger } from '@shared/log';
import type { VideoInfo } from '@shared/model';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage, execTool, ToolError } from './exec';
import type { MediaTools } from './media-tools';

const log = createLogger('probe');

const PROBE_TIMEOUT_MS = 30_000;
/** Counting reads the whole file (without decoding it): long for big files on slow drives. */
const COUNT_TIMEOUT_MS = 10 * 60_000;
/**
 * Reading a whole file for a duration it does not record happens while videos are added: long
 * enough for a big recording, short enough that a slow drive does not keep it probing for good.
 */
const DURATION_SCAN_TIMEOUT_MS = 2 * 60_000;
/** Packet listings of long videos: about 20 bytes a frame. */
const LISTING_MAX_BYTES = 256 * 1024 * 1024;
/** How far back from a cut the keyframe lookup reads first, in seconds. */
const KEYFRAME_WINDOW_SEC = 30;
/**
 * Frames a decoder may hold back before showing one (B-frames: H.264 and HEVC allow up to 16). The
 * first frames to show are among the first packets, plus this many.
 */
const REORDER_FRAMES = 16;
/** A recorded frame count further than this from duration × frame rate counts hidden frames too. */
const FRAME_COUNT_TOLERANCE = 1.5;

/** For interlaced video, which field shows first. */
export type FieldOrder = 'tff' | 'bff';

/** The video stream a job works on. Times are absolute timestamps of the file, in seconds. */
export interface VideoStream {
  /** Absolute stream index, as `-map 0:<index>` takes it. */
  readonly index: number;
  readonly codec: string;
  readonly pixFmt: string | null;
  /** Full-range (JPEG) levels, as the stream says or its pixel format (`yuvj…`) implies. */
  readonly fullRange: boolean;
  /** Timestamp of its first frame; differs from the format's when audio starts earlier or later. */
  readonly startSec: number;
  /**
   * The stream's start as its container gives it, which ffmpeg's time line goes by, when
   * `startSec` is the first frame as decoded (see `firstFrame`): later in a recording that starts
   * with frames that do not decode.
   */
  readonly streamStartSec?: number;
  readonly durationSec: number;
  readonly frameRate: number | null;
  /** As the container records it, when it agrees with the duration (see `frameCountOf`). */
  readonly frameCount: number | null;
  /** Bits per second, when the container tells. */
  readonly bitRate: number | null;
  /** Degrees, as the display matrix says; `0` when upright. */
  readonly rotation: number;
  /**
   * Interlaced video: the field that shows first, as the stream says; exact cuts check it on the
   * decoded frames (see `firstFrame`). `null` when progressive or unknown.
   */
  readonly fieldOrder: FieldOrder | null;
}

export interface AudioStream {
  readonly index: number;
  /** `null` when ffmpeg has no decoder for it, like the spatial audio (APAC) of recent iPhones. */
  readonly codec: string | null;
  readonly channels: number;
  /** ffmpeg's name for the channel layout, like `5.1(side)`; `null` when the order is unknown. */
  readonly layout: string | null;
  /** Timestamp of its first sample, when known. */
  readonly startSec: number | null;
}

export interface SubtitleStream {
  readonly index: number;
  readonly codec: string;
}

/** What planning needs to know about a source video, beyond what the interface shows. */
export interface MediaProbe {
  readonly info: VideoInfo;
  readonly video: VideoStream;
  readonly audio: readonly AudioStream[];
  readonly subtitles: readonly SubtitleStream[];
  /** Matroska attachments that are fonts: styled subtitles need them. Cover images are left out. */
  readonly fonts: readonly number[];
  /** The timestamp `-ss` counts from. */
  readonly formatStartSec: number;
  readonly formatBitRate: number | null;
  /**
   * Whether a stream of the file has B-frames, which a decoder holds back before showing (ffprobe's
   * `has_b_frames`): ffmpeg then seeks most containers early (see `PTS_SEEKING_CONTAINERS`).
   */
  readonly bFrames: boolean;
}

/** The file cannot be processed; `message` is for the user. */
export class UnsupportedMediaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UnsupportedMediaError';
  }
}

/** Reads a video with ffprobe. Rejects with an `UnsupportedMediaError` when it is not one. */
export async function probeVideo(
  tools: MediaTools,
  file: string,
  signal?: AbortSignal,
): Promise<MediaProbe> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch (error) {
    throw new UnsupportedMediaError('This file was moved or deleted.', { cause: error });
  }
  const json = await runProbe(
    tools,
    file,
    signal,
    'This file cannot be read: it may be damaged, or not a video.',
  );
  const video = videoStreamOf(json);
  const endSec =
    video !== undefined && streamDurationOf(video) === null
      ? await scanEnd(tools, file, indexOf(video), signal)
      : null;
  return parseVideoProbe(json, file, size, endSec, tools.decodable);
}

/**
 * Where a video stream ends, from its packets, for streams that record no duration (FLV, WebM from
 * a browser's MediaRecorder, unfinished live recordings): the end of its last frame. Reads the whole
 * file, without decoding it. `null` when the packets have no timestamps or the scan fails.
 */
async function scanEnd(
  tools: MediaTools,
  file: string,
  streamIndex: number,
  signal: AbortSignal | undefined,
): Promise<number | null> {
  try {
    const { stdout } = await execTool(
      tools.ffprobe,
      [
        ...['-v', 'error', '-select_streams', String(streamIndex)],
        ...['-show_entries', 'packet=pts_time,duration_time', '-print_format', 'csv=p=0', file],
      ],
      {
        timeoutMs: DURATION_SCAN_TIMEOUT_MS,
        maxBuffer: LISTING_MAX_BYTES,
        ...(signal ? { signal } : {}),
      },
    );
    return lastPacketEnd(stdout.toString('utf8'));
  } catch (error) {
    if (signal?.aborted === true) {
      throw error;
    }
    log.warn(`Cannot scan ${file} for its duration:`, errorMessage(error));
    return null;
  }
}

/** The latest `pts + duration` in a CSV packet listing of `pts_time,duration_time` lines. */
export function lastPacketEnd(csv: string): number | null {
  let end: number | null = null;
  for (const line of csv.split(/\r?\n/)) {
    const [ptsText, durationText] = line.trim().split(',');
    const pts = toNumber(ptsText);
    if (pts !== null) {
      end = Math.max(end ?? pts, pts + (toNumber(durationText) ?? 0));
    }
  }
  return end;
}

/** Duration of an audio file; rejects with a user-facing Error when it has no audio stream or cannot be read. */
export async function probeAudio(
  tools: MediaTools,
  file: string,
): Promise<{ readonly durationSec: number }> {
  const { durationSec } = await probeAudioTrack(tools, file);
  return { durationSec };
}

export interface AudioTrackProbe {
  readonly durationSec: number;
  readonly channels: number;
  readonly layout: string | null;
}

/** The first audio stream of a replacement soundtrack. */
export async function probeAudioTrack(
  tools: MediaTools,
  file: string,
  signal?: AbortSignal,
): Promise<AudioTrackProbe> {
  const json = await runProbe(tools, file, signal, 'This file cannot be read as audio.');
  return parseAudioProbe(json);
}

/** The frames of a video stream, as its packets tell (see `scanFrames`). */
export interface FrameScan {
  /** Frames shown, from the start. Those an edit list hides (decoded, never shown) are left out. */
  readonly count: number;
  /**
   * When each of them shows, in absolute timestamps, ascending; `null` when some packet has no
   * presentation time (AVI with B-frames).
   */
  readonly times: readonly number[] | null;
  /** Whether the scan read the whole stream: then `count` is every frame. */
  readonly complete: boolean;
}

/** How to read packets (see `scanFrames`, `findKeyframe`). */
export interface PacketOptions {
  /**
   * Give packets without a presentation time the one a stream copy works out (`-fflags +genpts`,
   * see `generatesTimes`), so that the times read are those of the copy.
   */
  readonly genpts?: boolean;
  readonly signal?: AbortSignal;
}

/** The ffprobe input options for `options`, before the file. */
function packetArgs(options: PacketOptions): readonly string[] {
  return options.genpts === true ? ['-fflags', '+genpts'] : [];
}

/**
 * Reads the packets of a video stream, without decoding them: all of them, or, with `first`, at
 * least enough to know the first `first` frames to show (B-frames are stored out of order).
 */
export async function scanFrames(
  tools: MediaTools,
  file: string,
  streamIndex: number,
  first: number | null,
  options: PacketOptions = {},
): Promise<FrameScan> {
  const { signal } = options;
  const list = async (packets: number | null) => {
    const { stdout } = await execTool(
      tools.ffprobe,
      [
        ...['-v', 'error', ...packetArgs(options), '-select_streams', String(streamIndex)],
        ...(packets === null ? [] : ['-read_intervals', `%+#${String(packets)}`]),
        ...['-show_entries', 'packet=pts_time,flags', '-print_format', 'csv=p=0', file],
      ],
      { timeoutMs: COUNT_TIMEOUT_MS, maxBuffer: LISTING_MAX_BYTES, ...(signal ? { signal } : {}) },
    );
    return parseFrameListing(stdout.toString('utf8'));
  };
  if (first === null) {
    const { count, times } = await list(null);
    return { count, times, complete: true };
  }
  for (let packets = first + 2 * REORDER_FRAMES; ; packets *= 4) {
    const { count, times, packets: read } = await list(packets);
    // Fewer packets than asked for: the stream ended.
    const complete = read < packets;
    // Packets hidden by an edit list come first: read further until enough frames show.
    if (complete || count >= first + REORDER_FRAMES) {
      return { count, times, complete };
    }
  }
}

/**
 * Reads a CSV listing of `pts_time,flags` packet lines (ffprobe's own field order): packets in
 * all, frames shown (flags without `D`, for discarded) and when they show, sorted.
 */
export function parseFrameListing(csv: string): {
  readonly packets: number;
  readonly count: number;
  readonly times: readonly number[] | null;
} {
  let packets = 0;
  let count = 0;
  let timed = true;
  const times: number[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const [ptsText, flags] = line.trim().split(',');
    if (flags === undefined) {
      continue;
    }
    packets++;
    if (flags.includes('D')) {
      continue;
    }
    count++;
    const pts = toNumber(ptsText);
    if (pts === null) {
      timed = false;
    } else {
      times.push(pts);
    }
  }
  return { packets, count, times: timed ? times.sort((a, b) => a - b) : null };
}

/** The first frames of a video stream, as decoded (see `firstFrame`). */
export interface FirstFrame {
  /** When the first one shows. */
  readonly startSec: number;
  /** The field interlaced frames show first; `null` when they are not marked interlaced. */
  readonly fieldOrder: FieldOrder | null;
}

/**
 * Decodes the first frames, for what only decoding tells. Their timestamp is what ffmpeg's
 * timeline goes by: it differs from the stream's start where the container stores no presentation
 * times (AVI with B-frames: the first frame shows after the decoder's delay). And the codec says
 * which field comes first more reliably than the container. `null` when no frame decodes.
 */
export async function firstFrame(
  tools: MediaTools,
  file: string,
  streamIndex: number,
  signal?: AbortSignal,
): Promise<FirstFrame | null> {
  const { stdout } = await execTool(
    tools.ffprobe,
    [
      // A few packets: enough for the decoder to put out its first frames in display order.
      ...['-v', 'error', '-select_streams', String(streamIndex), '-read_intervals', '%+#16'],
      ...['-show_entries', 'frame=best_effort_timestamp_time,interlaced_frame,top_field_first'],
      ...['-print_format', 'json', file],
    ],
    { timeoutMs: PROBE_TIMEOUT_MS, ...(signal ? { signal } : {}) },
  );
  const json = field(parseJson(stdout), 'frames');
  const frames = Array.isArray(json) ? (json as unknown[]) : [];
  const times = frames
    .map((frame) => toNumber(field(frame, 'best_effort_timestamp_time')))
    .filter((time) => time !== null);
  if (times.length === 0) {
    return null;
  }
  const interlaced = frames.find((frame) => toNumber(field(frame, 'interlaced_frame')) === 1);
  return {
    startSec: Math.min(...times),
    fieldOrder: interlaced === undefined ? null : frameFieldOrder(interlaced),
  };
}

function frameFieldOrder(frame: unknown): FieldOrder {
  return toNumber(field(frame, 'top_field_first')) === 1 ? 'tff' : 'bff';
}

/** A keyframe's timestamps, absolute, in seconds. */
export interface Keyframe {
  /** When it shows. */
  readonly ptsSec: number;
  /** When it is decoded: earlier than `ptsSec` in streams with B-frames. */
  readonly dtsSec: number;
}

/**
 * The last keyframe at or before `atSec` (an absolute timestamp), where a stream copy that cuts at
 * `atSec` really starts. Reads packets, without decoding: first in the window before `atSec`, then
 * from the start for videos with very long keyframe intervals. `null` when none is found.
 */
export async function findKeyframe(
  tools: MediaTools,
  file: string,
  streamIndex: number,
  atSec: number,
  options: PacketOptions = {},
): Promise<Keyframe | null> {
  const { signal } = options;
  const end = atSec.toFixed(6);
  const windowStart = atSec - KEYFRAME_WINDOW_SEC;
  const intervals = windowStart > 0 ? [`${windowStart.toFixed(6)}%${end}`, `%${end}`] : [`%${end}`];
  for (const interval of intervals) {
    const { stdout } = await execTool(
      tools.ffprobe,
      [
        ...['-v', 'error', ...packetArgs(options), '-select_streams', String(streamIndex)],
        ...['-read_intervals', interval],
        // CSV keeps the listing small when it covers a long video from its start.
        ...['-show_entries', 'packet=pts_time,dts_time,flags', '-print_format', 'csv=p=0', file],
      ],
      { timeoutMs: COUNT_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, ...(signal ? { signal } : {}) },
    );
    const keyframe = lastKeyframe(stdout.toString('utf8'), atSec);
    if (keyframe !== null) {
      return keyframe;
    }
  }
  return null;
}

/**
 * When the first frame of a result shows, read from the packets without decoding: for a cut that
 * decodes from `atSec` (an absolute timestamp), the first frame at or after it, which comes later
 * than the frame rate says where frames are far apart; for a stream copied from its start
 * (`atSec` `null`), the first frame that can be decoded. A recording that starts in the middle of
 * a group of pictures (DVB and IPTV captures) begins with frames that never show: those before its
 * first keyframe, or shown before it. `null` when none is found.
 */
export async function firstShownFrame(
  tools: MediaTools,
  file: string,
  streamIndex: number,
  atSec: number | null,
  options: PacketOptions = {},
): Promise<number | null> {
  const { signal } = options;
  const from = atSec === null ? '' : atSec.toFixed(6);
  for (let packets = 4 * REORDER_FRAMES; ; packets *= 4) {
    const { stdout } = await execTool(
      tools.ffprobe,
      [
        ...['-v', 'error', ...packetArgs(options), '-select_streams', String(streamIndex)],
        ...['-read_intervals', `${from}%+#${String(packets)}`],
        ...['-show_entries', 'packet=pts_time,flags', '-print_format', 'csv=p=0', file],
      ],
      { timeoutMs: COUNT_TIMEOUT_MS, maxBuffer: LISTING_MAX_BYTES, ...(signal ? { signal } : {}) },
    );
    const shown = firstShownTime(stdout.toString('utf8'), atSec);
    // Frames stored after it may show before it: read on until as many as B-frames reorder.
    if (
      shown.packets < packets ||
      (shown.at !== null && shown.packets - shown.at > REORDER_FRAMES)
    ) {
      return shown.timeSec;
    }
  }
}

/**
 * The first frame shown in a CSV listing of `pts_time,flags` packet lines (see `firstShownFrame`):
 * its time, the index of the first packet that qualified, and the packets read. Frames an edit list
 * hides (`D`) never show.
 */
export function firstShownTime(
  csv: string,
  atSec: number | null,
): { readonly timeSec: number | null; readonly at: number | null; readonly packets: number } {
  let packets = 0;
  let from = atSec;
  let timeSec: number | null = null;
  let at: number | null = null;
  for (const line of csv.split(/\r?\n/)) {
    const [ptsText, flags] = line.trim().split(',');
    if (flags === undefined) {
      continue;
    }
    const pts = toNumber(ptsText);
    // From the start, frames show from the first keyframe on.
    if (from === null && flags.startsWith('K') && pts !== null) {
      from = pts;
    }
    if (from !== null && pts !== null && pts >= from && !flags.includes('D')) {
      at ??= packets;
      timeSec = timeSec === null ? pts : Math.min(timeSec, pts);
    }
    packets++;
  }
  return { timeSec, at, packets };
}

/**
 * The latest keyframe at or before `atSec` in a CSV packet listing: `pts_time,dts_time,flags` per
 * line (ffprobe's own field order), times `N/A` when unknown.
 */
export function lastKeyframe(csv: string, atSec: number): Keyframe | null {
  let found: Keyframe | null = null;
  for (const line of csv.split(/\r?\n/)) {
    const [ptsText, dtsText, flags = ''] = line.trim().split(',');
    const dts = toNumber(dtsText);
    const pts = toNumber(ptsText) ?? dts;
    const later = pts !== null && pts <= atSec && (found === null || pts > found.ptsSec);
    if (flags.startsWith('K') && later) {
      found = { ptsSec: pts, dtsSec: dts ?? pts };
    }
  }
  return found;
}

async function runProbe(
  tools: MediaTools,
  file: string,
  signal: AbortSignal | undefined,
  unreadable: string,
): Promise<unknown> {
  try {
    const { stdout } = await execTool(
      tools.ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeoutMs: PROBE_TIMEOUT_MS, ...(signal ? { signal } : {}) },
    );
    return parseJson(stdout);
  } catch (error) {
    if (signal?.aborted === true) {
      throw error;
    }
    const detail = error instanceof ToolError ? error.stderr.trim() : errorMessage(error);
    log.warn(`ffprobe cannot read ${file}: ${detail}`);
    throw new UnsupportedMediaError(unreadable, { cause: error });
  }
}

/** The video stream of ffprobe's JSON; cover art of MP3/M4A files is one picture, not a video. */
function videoStreamOf(json: unknown): unknown {
  return streamsOf(json).find(
    (stream) =>
      field(stream, 'codec_type') === 'video' &&
      toNumber(field(field(stream, 'disposition'), 'attached_pic')) !== 1,
  );
}

/**
 * Builds the probe of a video from ffprobe's `-show_format -show_streams` JSON. `scannedEndSec`:
 * where the video stream ends as its packets tell, for streams that record no duration.
 * `decodable`: the codecs ffmpeg can decode (see `MediaTools`); `null`: those ffprobe names.
 */
export function parseVideoProbe(
  json: unknown,
  file: string,
  sizeBytes: number,
  scannedEndSec: number | null = null,
  decodable: ReadonlySet<string> | null = null,
): MediaProbe {
  const streams = streamsOf(json);
  const format = field(json, 'format');
  const video = videoStreamOf(json);
  if (video === undefined) {
    throw new UnsupportedMediaError('No video stream: this is not a video.');
  }
  const formatStartSec = toNumber(field(format, 'start_time')) ?? 0;
  const startSec = toNumber(field(video, 'start_time')) ?? formatStartSec;
  // Where its packets end beats the file's duration, when the stream records none.
  const durationSec =
    streamDurationOf(video) ??
    positive(scannedEndSec === null ? null : scannedEndSec - startSec) ??
    durationOf(video, format);
  if (durationSec === null) {
    throw new UnsupportedMediaError('Its duration is unknown: it cannot be processed.');
  }
  const width = toNumber(field(video, 'width')) ?? 0;
  const height = toNumber(field(video, 'height')) ?? 0;
  const rotation = rotationOf(video);
  const sideways = Math.abs(rotation) % 180 === 90;
  const frameRate =
    frameRateOf(field(video, 'avg_frame_rate')) ?? frameRateOf(field(video, 'r_frame_rate'));
  const frameCount = frameCountOf(toNumber(field(video, 'nb_frames')), durationSec, frameRate);
  const codec = stringField(video, 'codec_name') ?? 'unknown';
  const pixFmt = stringField(video, 'pix_fmt');
  const audio = streams
    .filter((stream) => field(stream, 'codec_type') === 'audio')
    .map((stream): AudioStream => ({
      index: indexOf(stream),
      codec: decodableCodec(stringField(stream, 'codec_name'), decodable),
      channels: toNumber(field(stream, 'channels')) ?? 2,
      layout: layoutOf(stream),
      startSec: toNumber(field(stream, 'start_time')),
    }));
  const [firstAudio] = audio;
  return {
    info: {
      durationSec,
      width: sideways ? height : width,
      height: sideways ? width : height,
      frameRate,
      frameCount,
      videoCodec: codec,
      audioCodec: firstAudio === undefined ? null : (firstAudio.codec ?? 'unknown'),
      container: path.extname(file).slice(1).toLowerCase(),
      sizeBytes,
    },
    video: {
      index: indexOf(video),
      codec,
      pixFmt,
      fullRange:
        stringField(video, 'color_range') === 'pc' || (pixFmt?.startsWith('yuvj') ?? false),
      startSec,
      durationSec,
      frameRate,
      frameCount,
      bitRate: positive(toNumber(field(video, 'bit_rate'))),
      rotation,
      fieldOrder: fieldOrderOf(stringField(video, 'field_order')),
    },
    audio,
    subtitles: streams
      .filter((stream) => field(stream, 'codec_type') === 'subtitle')
      .map((stream) => ({
        index: indexOf(stream),
        codec: stringField(stream, 'codec_name') ?? 'unknown',
      })),
    fonts: streams.filter(isFont).map(indexOf),
    formatStartSec,
    formatBitRate: positive(toNumber(field(format, 'bit_rate'))),
    bFrames: streams.some((stream) => (toNumber(field(stream, 'has_b_frames')) ?? 0) > 0),
  };
}

/** `codec`, unless ffmpeg cannot decode it. */
function decodableCodec(
  codec: string | null,
  decodable: ReadonlySet<string> | null,
): string | null {
  return codec !== null && (decodable?.has(codec) ?? true) ? codec : null;
}

/** Builds the probe of a soundtrack from ffprobe's JSON. */
export function parseAudioProbe(json: unknown): AudioTrackProbe {
  const stream = streamsOf(json).find((candidate) => field(candidate, 'codec_type') === 'audio');
  if (stream === undefined) {
    throw new UnsupportedMediaError('No audio stream: this is not an audio file.');
  }
  const durationSec = durationOf(stream, field(json, 'format'));
  if (durationSec === null) {
    throw new UnsupportedMediaError('Its duration is unknown: it cannot be used.');
  }
  return {
    durationSec,
    channels: toNumber(field(stream, 'channels')) ?? 2,
    layout: layoutOf(stream),
  };
}

function layoutOf(stream: unknown): string | null {
  const layout = stringField(stream, 'channel_layout');
  return layout === 'unknown' ? null : layout;
}

/**
 * Length of a stream: its own duration, else Matroska's `DURATION` tag, else the container's. The
 * tag is where the stream ends (as ffmpeg writes it): a stream starting at 0.021 s and lasting 3 s
 * says 3.021.
 */
function durationOf(stream: unknown, format: unknown): number | null {
  return streamDurationOf(stream) ?? positive(toNumber(field(format, 'duration')));
}

/**
 * The duration a stream records itself, or Matroska's DURATION tag (its end timestamp). The file's
 * duration is no substitute for a video: FLV gives the end time of its last frame, which counts the
 * video's start (67 ms with B-frames) once more.
 */
function streamDurationOf(stream: unknown): number | null {
  const end = clockSeconds(field(field(stream, 'tags'), 'DURATION'));
  const start = toNumber(field(stream, 'start_time')) ?? 0;
  return (
    positive(toNumber(field(stream, 'duration'))) ?? positive(end === null ? null : end - start)
  );
}

/**
 * The frame count the container records, unless it disagrees with the duration: MP4 and MOV count
 * the frames an edit list hides as well (in videos cut without re-encoding), which never show.
 */
function frameCountOf(
  recorded: number | null,
  durationSec: number,
  frameRate: number | null,
): number | null {
  if (recorded === null || !Number.isSafeInteger(recorded) || recorded <= 0) {
    return null;
  }
  return frameRate === null || Math.abs(recorded - durationSec * frameRate) <= FRAME_COUNT_TOLERANCE
    ? recorded
    : null;
}

/**
 * ffprobe's field order, `tt`, `bb`, `tb` or `bt`, as the field that shows first. ffmpeg documents
 * the second letter as that field, but files disagree: the same top-first video is tagged `tt` or
 * `tb` (ffmpeg itself writes a top-first ProRes MOV that reads back `tb`). The first letter, the
 * field stored first, is the better guess; exact cuts check the decoded frames (see `firstFrame`).
 */
function fieldOrderOf(value: string | null): FieldOrder | null {
  switch (value) {
    case 'tt':
    case 'tb':
      return 'tff';
    case 'bb':
    case 'bt':
      return 'bff';
    default:
      return null;
  }
}

/** Frames per second from an ffprobe rational (`30000/1001`); `null` when unknown or implausible. */
export function frameRateOf(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const [numerator, denominator] = value.split('/').map(Number);
  if (numerator === undefined || denominator === undefined || denominator === 0) {
    return null;
  }
  const rate = numerator / denominator;
  // VFR files can report a timebase-like rate (90000/1): not a frame rate anyone recorded.
  return Number.isFinite(rate) && rate >= 0.1 && rate <= 1000 ? rate : null;
}

function rotationOf(stream: unknown): number {
  const sideData = field(stream, 'side_data_list');
  if (Array.isArray(sideData)) {
    for (const entry of sideData as unknown[]) {
      const rotation = toNumber(field(entry, 'rotation'));
      if (rotation !== null) {
        return rotation;
      }
    }
  }
  return toNumber(field(field(stream, 'tags'), 'rotate')) ?? 0;
}

function isFont(stream: unknown): boolean {
  if (field(stream, 'codec_type') !== 'attachment') {
    return false;
  }
  const tags = field(stream, 'tags');
  const mimetype = stringField(tags, 'mimetype') ?? '';
  const filename = stringField(tags, 'filename') ?? '';
  return /font|truetype|opentype|sfnt/i.test(mimetype) || /\.(ttf|otf|ttc|woff2?)$/i.test(filename);
}

/** `00:00:03.003000000`, as Matroska stores track durations. */
function clockSeconds(value: unknown): number | null {
  const match = typeof value === 'string' ? /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value) : null;
  if (!match) {
    return null;
  }
  const [, hours = '0', minutes = '0', seconds = '0'] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function streamsOf(json: unknown): unknown[] {
  const streams = field(json, 'streams');
  return Array.isArray(streams) ? (streams as unknown[]) : [];
}

function indexOf(stream: unknown): number {
  return toNumber(field(stream, 'index')) ?? 0;
}

function parseJson(stdout: Buffer): unknown {
  return JSON.parse(stdout.toString('utf8')) as unknown;
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function stringField(value: unknown, key: string): string | null {
  const text = field(value, key);
  return typeof text === 'string' && text !== '' ? text : null;
}

/** ffprobe writes most numbers as strings, and `N/A` when unknown. */
function toNumber(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

function positive(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
}
