/**
 * Turns a recipe into one ffmpeg command for one video. Pure: everything it needs was probed
 * beforehand, so every combination can be tested without running ffmpeg.
 *
 * Cuts work in absolute timestamps of the video stream. Its first frame is at `startSec`, which may
 * differ from the format start that `-ss` counts from (MP4 audio priming, B-frame delay without an
 * edit list, Matroska codec delay). A trim in frames cuts at the time its frame shows, read from
 * the packets beforehand (see `framesToScan`), so it is exact whatever the frame rate does. Without
 * those times (AVI with B-frames stores none), and for trims in seconds, the frame rate is taken as
 * constant: frame k is at `startSec + k / frameRate`.
 */
import type { Recipe, Trim } from '@shared/model';
import { isTrimSet, reencodesVideo, trims } from '@shared/recipe';
import { formatDuration } from '@shared/time';
import type { MediaFeatures } from './media-tools';
import { fpsModeArgs } from './media-tools';
import type { AudioStream, Keyframe, MediaProbe, VideoStream } from './probe';

/** Output containers by extension, and the muxer that writes each. */
const MUXERS = { mp4: 'mp4', m4v: 'mp4', mov: 'mov', mkv: 'matroska', webm: 'webm' } as const;

export type OutputContainer = keyof typeof MUXERS;

/**
 * The container of the result. Common ones are kept; others (AVI, WMV, MPEG-TS…) become MP4 when
 * the video is re-encoded to H.264, else Matroska, which accepts whatever codec they hold.
 */
export function outputContainer(sourceContainer: string, reencodes: boolean): OutputContainer {
  switch (sourceContainer) {
    case 'mp4':
    case 'm4v':
    case 'mov':
    case 'mkv':
    case 'webm':
      return sourceContainer;
    case 'qt':
      return 'mov';
    default:
      return reencodes ? 'mp4' : 'mkv';
  }
}

/**
 * MPEG transport and program streams (ffmpeg's demuxers with timestamp discontinuities). They have
 * no index: a seek bisects the file, then resumes at the next keyframe, which may come after the
 * target. And ffmpeg's timeline then starts with the earliest of the streams used, not with the
 * format, which also throws off seeks when some streams are left out. So these are cut by seeking
 * the output instead: read from the start, dropping what comes before the cut.
 */
const BISECTED_CONTAINERS: readonly string[] = ['ts', 'm2ts', 'mts', 'mpg', 'mpeg'];

/**
 * Containers whose packets may lack a presentation time: AVI keeps decoding times only, and an
 * MPEG program stream times each packet, which small frames can share. Copied B-frames would reach
 * the muxer without one, which it refuses: the demuxer can work them out (`-fflags +genpts`).
 */
const UNTIMED_CONTAINERS: readonly string[] = ['avi', 'mpg', 'mpeg'];

/**
 * Whether ffmpeg works out the presentation times of the video as it copies it (see
 * `UNTIMED_CONTAINERS`). A fast cut then goes by those times, which ffprobe gives as well with the
 * same flag (see `scanFrames`, `findKeyframe`): in AVI, the copy shows the first frame a frame
 * after its decoding time, though the stream's start says 0.
 */
export function generatesTimes(recipe: Recipe, probe: MediaProbe): boolean {
  return !reencodesVideo(recipe) && UNTIMED_CONTAINERS.includes(probe.info.container);
}

/**
 * Containers whose demuxer seeks by presentation time (ffmpeg's `AVFMT_SEEK_TO_PTS`): those of the
 * MOV demuxer. In the others (Matroska, WebM, AVI, FLV), when a stream has B-frames, whose
 * decoding times come before their presentation times, ffmpeg seeks `DTS_SEEK_LEAD_SEC` before the
 * time asked: a stream copy would start one keyframe early whenever the one asked for is closer.
 */
const PTS_SEEKING_CONTAINERS: readonly string[] = ['mp4', 'm4v', 'mov', 'qt', '3gp'];

/** How far before `-ss` ffmpeg seeks in the other containers (its own constant, `3/23` s). */
const DTS_SEEK_LEAD_SEC = 3 / 23;

type VideoFamily = 'h264' | 'hevc' | 'vp9' | 'av1';

/** What each muxer takes when we encode. `m4v` is written by the MP4 muxer: the iPod one refuses HEVC. */
const ACCEPTED_VIDEO: Readonly<Record<OutputContainer, readonly VideoFamily[]>> = {
  mp4: ['h264', 'hevc', 'vp9', 'av1'],
  m4v: ['h264', 'hevc', 'vp9', 'av1'],
  mov: ['h264', 'hevc'],
  mkv: ['h264', 'hevc', 'vp9', 'av1'],
  webm: ['vp9', 'av1'],
};

/** Subtitle codecs each muxer can copy; others are dropped rather than failing the job. */
const COPYABLE_SUBTITLES: Readonly<Record<OutputContainer, readonly string[]>> = {
  mp4: ['mov_text', 'dvd_subtitle'],
  m4v: ['mov_text', 'dvd_subtitle'],
  mov: ['mov_text'],
  mkv: ['subrip', 'ass', 'ssa', 'webvtt', 'hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle'],
  webm: ['webvtt'],
};

interface VideoEncoder {
  readonly name: string;
  readonly args: (bitRate: number, container: OutputContainer) => readonly string[];
}

/** Hardware and OS encoders have no quality scale: they get the source's bit rate. */
function atBitRate(name: string): VideoEncoder {
  return { name, args: (bitRate) => ['-c:v', name, '-b:v', String(Math.round(bitRate))] };
}

/** Candidates by family, best first. */
const VIDEO_ENCODERS: Readonly<Record<VideoFamily, readonly VideoEncoder[]>> = {
  h264: [
    { name: 'libx264', args: () => ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18'] },
    // Builds without libx264 (LGPL): the OS encoders, then Cisco's.
    atBitRate('h264_videotoolbox'),
    atBitRate('h264_mf'),
    atBitRate('libopenh264'),
  ],
  hevc: [
    {
      name: 'libx265',
      args: (_, container) => [
        ...['-c:v', 'libx265', '-preset', 'medium', '-crf', '20'],
        ...['-x265-params', 'log-level=error'],
        // Apple players only take HEVC tagged hvc1 (ffmpeg writes hev1 by default).
        ...(container === 'mkv' ? [] : ['-tag:v', 'hvc1']),
      ],
    },
  ],
  vp9: [
    {
      name: 'libvpx-vp9',
      args: () => [
        ...['-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-row-mt', '1'],
        ...['-deadline', 'good', '-cpu-used', '4'],
      ],
    },
  ],
  av1: [
    { name: 'libsvtav1', args: () => ['-c:v', 'libsvtav1', '-crf', '30', '-preset', '8'] },
    {
      name: 'libaom-av1',
      args: () => [
        ...['-c:v', 'libaom-av1', '-crf', '30', '-b:v', '0'],
        ...['-cpu-used', '6', '-row-mt', '1'],
      ],
    },
  ],
};

/** Families to try for a source codec: the same one first, then what plays everywhere. */
function familiesFor(codec: string): readonly VideoFamily[] {
  switch (codec) {
    case 'h264':
      return ['h264'];
    case 'hevc':
      return ['hevc', 'h264'];
    case 'vp8':
    case 'vp9':
      return ['vp9', 'av1', 'h264'];
    case 'av1':
      return ['av1', 'vp9', 'h264'];
    default:
      // WebM takes neither H.264 nor the source codec: VP9 or AV1 then.
      return ['h264', 'vp9', 'av1'];
  }
}

const DEFAULT_BIT_RATE = 8_000_000;

interface AudioEncoder {
  readonly name: string;
  /** Bits per second for a stream of that many channels. */
  readonly bitRate: (channels: number) => string;
  /** Layouts the encoder takes, when it refuses others instead of converting them; `null`: any. */
  readonly layouts: readonly string[] | null;
}

/** The usual layout for a number of channels, for streams whose layout is unknown or refused. */
const STANDARD_LAYOUTS: readonly string[] = [
  'mono',
  'stereo',
  '3.0',
  'quad',
  '5.0',
  '5.1',
  '6.1',
  '7.1',
];

const aac = (name: string): AudioEncoder => ({
  name,
  bitRate: (channels) => (channels <= 2 ? '192k' : '384k'),
  layouts: null,
});

const AAC_ENCODERS: readonly AudioEncoder[] = [
  aac('aac'),
  aac('aac_at'),
  aac('aac_mf'),
  aac('libfdk_aac'),
];

const WEBM_AUDIO_ENCODERS: readonly AudioEncoder[] = [
  {
    name: 'libopus',
    bitRate: (channels) => (channels <= 2 ? '160k' : '320k'),
    // libopus refuses layouts like 5.1(side) instead of converting them.
    layouts: STANDARD_LAYOUTS,
  },
  { name: 'libvorbis', bitRate: (channels) => (channels <= 2 ? '160k' : '320k'), layouts: null },
];

/** Fractions of a frame smaller than this are float noise, not part of a frame. */
const FRAME_EPSILON = 1e-3;

/**
 * Margin between a cut and the frame it starts at, against timestamp rounding (Matroska stores
 * milliseconds; MP4 time bases can be coarse). It must stay well under half a frame: an exact cut
 * starts a margin before its first frame, and when its length alone ends it, that length stops a
 * margin before the first frame removed, so two margins before it.
 */
export function cutMargin(frameRate: number | null): number {
  return frameRate === null ? 0.001 : Math.min(0.002, 0.25 / frameRate);
}

/** The part of the video stream to keep, in absolute timestamps. */
export interface KeptRange {
  /** First timestamp kept; `null`: from the start. */
  readonly fromSec: number | null;
  /** First timestamp removed; `null`: to the end. */
  readonly untilSec: number | null;
  /** Frames kept, for an end trim in frames: there the count is what defines the cut. */
  readonly frames: number | null;
}

export type RangeResult =
  | { readonly ok: true; readonly range: KeptRange }
  | { readonly ok: false; readonly message: string };

/** When the first frames of the video stream show, from a scan of its packets (see `scanFrames`). */
export interface FrameTimes {
  /** Absolute timestamps, ascending. */
  readonly times: readonly number[];
  /** Whether these are all the frames, not only the first ones. */
  readonly complete: boolean;
}

/**
 * Where the trims cut. With a known frame rate, seconds are rounded up to the next frame, so a cut
 * never splits a frame: removing 0.5 s at 30 fps removes frames 0 to 14. `totalFrames` is needed for
 * an end trim in frames. With `frameTimes`, trims in frames cut at the time their frame shows.
 */
export function keptRange(
  recipe: Recipe,
  video: VideoStream,
  totalFrames: number | null,
  frameTimes: FrameTimes | null = null,
): RangeResult {
  const { startSec, durationSec, frameRate } = video;
  const empty = {
    ok: false,
    message: `The trims remove all of it (${formatDuration(durationSec)} long).`,
  } as const;
  if (frameRate === null) {
    if (
      [recipe.trimStart, recipe.trimEnd].some((trim) => trim.unit === 'frames' && isTrimSet(trim))
    ) {
      return { ok: false, message: 'Its frame rate is unknown: trim it in seconds.' };
    }
    const from = isTrimSet(recipe.trimStart) ? recipe.trimStart.amount : 0;
    const until = durationSec - (isTrimSet(recipe.trimEnd) ? recipe.trimEnd.amount : 0);
    if (until - from < 0.001) {
      return empty;
    }
    return {
      ok: true,
      range: {
        fromSec: from > 0 ? startSec + from : null,
        untilSec: isTrimSet(recipe.trimEnd) ? startSec + until : null,
        frames: null,
      },
    };
  }
  const complete = frameTimes?.complete === true ? frameTimes.times : null;
  const total = complete?.length ?? totalFrames;
  const startsInFrames = recipe.trimStart.unit === 'frames' && isTrimSet(recipe.trimStart);
  const endsInFrames = recipe.trimEnd.unit === 'frames' && isTrimSet(recipe.trimEnd);
  /** When frame `index` shows: as scanned for a trim in frames, else on the frame rate's grid. */
  const timeOf = (index: number, inFrames: boolean): number =>
    (inFrames ? frameTimes?.times[index] : undefined) ?? startSec + index / frameRate;
  /** Frames before a cut, on the scanned time line, which need not be regular (see `timingOf`). */
  const before = (times: readonly number[], cutSec: number): number =>
    times.filter((time) => time < cutSec - cutMargin(frameRate)).length;

  const start = startFrame(recipe.trimStart, frameRate);
  const fromSec = start > 0 ? timeOf(start, startsInFrames) : null;
  const end = endFrame(recipe.trimEnd, frameRate, durationSec, total);
  if (end === 'unknown') {
    return { ok: false, message: 'Its number of frames is unknown: trim its end in seconds.' };
  }
  const untilSec = end === null ? null : timeOf(end, endsInFrames);
  // Cuts in seconds are on the grid, not on the scanned frames: count the frames before them.
  const first =
    complete !== null && fromSec !== null && !startsInFrames ? before(complete, fromSec) : start;
  const last =
    complete !== null && untilSec !== null && !endsInFrames
      ? before(complete, untilSec)
      : (end ?? total ?? durationSec * frameRate);
  // Only the first frames scanned, for a start in frames: an end in seconds is compared in time.
  const kept =
    complete === null && startsInFrames && frameTimes !== null && untilSec !== null
      ? untilSec - (fromSec ?? startSec) > cutMargin(frameRate)
      : last - first >= (end === null && total === null ? 0.5 : 1);
  if (!kept) {
    return empty;
  }
  return {
    ok: true,
    range: { fromSec, untilSec, frames: end !== null && endsInFrames ? end - first : null },
  };
}

/** Index of the first frame kept. */
function startFrame(trim: Trim, frameRate: number): number {
  if (!isTrimSet(trim)) {
    return 0;
  }
  return trim.unit === 'frames' ? trim.amount : Math.ceil(trim.amount * frameRate - FRAME_EPSILON);
}

/** Index of the first frame removed at the end; `null` without an end trim. */
function endFrame(
  trim: Trim,
  frameRate: number,
  durationSec: number,
  totalFrames: number | null,
): number | null | 'unknown' {
  if (!isTrimSet(trim)) {
    return null;
  }
  if (trim.unit === 'frames') {
    return totalFrames === null ? 'unknown' : totalFrames - trim.amount;
  }
  const end = Math.ceil((durationSec - trim.amount) * frameRate - FRAME_EPSILON);
  return totalFrames === null ? end : Math.min(end, totalFrames);
}

/**
 * The frames whose times planning needs, read from the packets (see `scanFrames`): every one for an
 * end trim in frames, which counts them too (containers may not record how many, or count frames
 * that never show); the first ones for a start trim in frames. `null` when no trim is in frames.
 */
export function framesToScan(recipe: Recipe, probe: MediaProbe): number | 'all' | null {
  if (probe.video.frameRate === null) {
    // Trims in frames are refused.
    return null;
  }
  if (isTrimSet(recipe.trimEnd) && recipe.trimEnd.unit === 'frames') {
    return 'all';
  }
  return isTrimSet(recipe.trimStart) && recipe.trimStart.unit === 'frames'
    ? recipe.trimStart.amount + 1
    : null;
}

/**
 * For a start trim without re-encoding: the timestamp before which to look for the keyframe that a
 * stream copy really starts at (see `findKeyframe`). `null` when the video is not cut that way.
 */
export function keyframeLookup(
  recipe: Recipe,
  probe: MediaProbe,
  frameTimes: FrameTimes | null = null,
): number | null {
  if (reencodesVideo(recipe) || !isTrimSet(recipe.trimStart)) {
    return null;
  }
  // The start does not depend on the frame count.
  const result = keptRange(
    { ...recipe, trimEnd: { amount: 0, unit: 'seconds' } },
    probe.video,
    null,
    frameTimes,
  );
  return result.ok && result.range.fromSec !== null
    ? result.range.fromSec + cutMargin(probe.video.frameRate)
    : null;
}

/** How ffmpeg cuts: input seek, output length and frame count. */
interface Timing {
  /** `-ss` before the input, relative to the format start. */
  readonly seekSec: number | null;
  /** `-itsoffset` of the input: shifts the time line of the result, so that its start is at 0. */
  readonly inputOffsetSec: number | null;
  /** `-ss` after the inputs: the rest of the way to the cut, decoding and dropping frames. */
  readonly outputSeekSec: number | null;
  /** `-t`: length of the output, from where the seek lands. */
  readonly lengthSec: number | null;
  /** `-frames:v`: exact cuts in frames of a silent result stop on the last frame whatever the rounding. */
  readonly frames: number | null;
  /** Expected length of the result, for progress. */
  readonly durationSec: number;
  /** A stream copy starts at a keyframe before the cut: shift all streams so that it shows at 0. */
  readonly zeroTimestamps: boolean;
}

interface TimingOptions {
  /** Re-encoded: the cut is exact. */
  readonly exact: boolean;
  readonly keyframe: Keyframe | null;
  /** Whether the length is bounded even without an end trim (a new soundtrack must end too). */
  readonly bounded: boolean;
  /**
   * Whether the result has audio. Then `-frames:v` cannot end the video: on reaching the count,
   * ffmpeg ends every stream where it is, and the audio, behind, falls short (by 15 ms in ffmpeg 7.1
   * at best, by most of a second in MPEG streams with ffmpeg 5.1).
   */
  readonly audio: boolean;
  /** Cut MPEG streams without seeking the input (see `BISECTED_CONTAINERS`). */
  readonly bisected: boolean;
  /** Where ffmpeg's timeline starts when the input is not seeked. */
  readonly originSec: number;
  /** How far before the time asked ffmpeg seeks this input (see `PTS_SEEKING_CONTAINERS`). */
  readonly seekLeadSec: number;
}

function timingOf(range: KeptRange, probe: MediaProbe, options: TimingOptions): Timing {
  const { video, formatStartSec } = probe;
  const margin = cutMargin(video.frameRate);
  const end = range.untilSec ?? video.startSec + video.durationSec;
  const frames = options.exact && !options.audio ? range.frames : null;
  // Without a frame count (an end in seconds, or with audio), the length alone ends the video: a
  // margin before the first frame removed, which rounded timestamps may otherwise put just before
  // the cut.
  const endMargin = options.exact && range.untilSec !== null && frames === null ? margin : 0;
  const lengthFrom = (origin: number): number | null =>
    range.untilSec !== null || options.bounded ? end - endMargin - origin : null;
  const unseeked = {
    seekSec: null,
    inputOffsetSec: null,
    outputSeekSec: null,
    lengthSec: lengthFrom(options.originSec),
    frames,
    durationSec: end - options.originSec,
    zeroTimestamps: false,
  };
  if (range.fromSec === null) {
    return unseeked;
  }
  const { keyframe } = options;
  if (options.exact) {
    // Just before the first frame kept: frames before the seek point are decoded, then dropped.
    // The length counts from the seek point, so it ends a margin before `end` too.
    const seekAt = range.fromSec - margin;
    return {
      seekSec: options.bisected ? null : Math.max(0, seekAt - formatStartSec),
      inputOffsetSec: null,
      outputSeekSec: options.bisected ? seekAt - options.originSec : null,
      lengthSec: lengthFrom(range.fromSec),
      frames,
      durationSec: end - range.fromSec,
      zeroTimestamps: false,
    };
  }
  // A stream copy starts at the keyframe before the cut.
  const start = keyframe?.ptsSec ?? range.fromSec;
  if (options.bisected) {
    // The output seek drops packets decoded before it: start just before the keyframe's.
    const copyFrom = (keyframe?.dtsSec ?? range.fromSec) - margin;
    if (copyFrom <= options.originSec) {
      return unseeked;
    }
    return {
      seekSec: null,
      inputOffsetSec: null,
      outputSeekSec: copyFrom - options.originSec,
      lengthSec: lengthFrom(copyFrom),
      frames: null,
      durationSec: end - start,
      zeroTimestamps: true,
    };
  }
  // Just after the keyframe, so that the demuxer lands on it and not on the one before, ffmpeg's
  // own lead made up for. The result's time line counts from the seek point: shifted back by the
  // way from the keyframe to it, the keyframe shows at 0, where a new soundtrack starts, and the
  // length counts from it. Without a keyframe, the result starts wherever the seek lands.
  const seekSec = Math.max(0, start + margin + options.seekLeadSec - formatStartSec);
  const seekPoint = formatStartSec + seekSec;
  return {
    seekSec,
    inputOffsetSec: keyframe === null ? null : seekPoint - keyframe.ptsSec,
    outputSeekSec: null,
    lengthSec: lengthFrom(keyframe === null ? seekPoint : keyframe.ptsSec),
    frames: null,
    durationSec: end - start,
    zeroTimestamps: true,
  };
}

/** A replacement soundtrack: its first audio stream is used. */
export interface AudioTrackInput {
  readonly path: string;
  /** How long it lasts, which tells how often it starts over (see `loopsToLast`). */
  readonly durationSec: number;
  readonly channels: number;
  readonly layout: string | null;
}

export interface PlanInput {
  readonly source: string;
  /** Where ffmpeg writes; its extension matches `outputContainer`. */
  readonly output: string;
  readonly probe: MediaProbe;
  readonly recipe: Recipe;
  readonly encoders: ReadonlySet<string>;
  /** How this ffmpeg spells the options exact cuts need. */
  readonly features: MediaFeatures;
  /** The replacement soundtrack, when `recipe.audio` is `replace`. */
  readonly track: AudioTrackInput | null;
  /** Frames of the video stream, from the container or counted (see `framesToScan`). */
  readonly totalFrames: number | null;
  /** When the frames show, for trims in frames (see `framesToScan`); `null` when not known. */
  readonly frameTimes: FrameTimes | null;
  /** The keyframe found before `keyframeLookup`'s timestamp; `null` when not looked up or not found. */
  readonly keyframe: Keyframe | null;
}

export interface Plan {
  /** After the global options (`-hide_banner`, `-progress`…), which the runner adds. */
  readonly args: readonly string[];
  /** Expected length of the result, in seconds, for progress. */
  readonly durationSec: number;
  /**
   * Audio streams of the source left out (absolute indexes): ffmpeg cannot decode them, and the
   * output container cannot hold them as they are (see `carriesUndecodable`).
   */
  readonly droppedAudio: readonly number[];
}

export type PlanResult =
  { readonly ok: true; readonly plan: Plan } | { readonly ok: false; readonly message: string };

/** The ffmpeg arguments that apply `recipe` to one video, or why it cannot. */
export function planJob(input: PlanInput): PlanResult {
  const { probe, recipe } = input;
  const exact = reencodesVideo(recipe);
  const container = outputContainer(probe.info.container, exact);
  const ranged = trims(recipe)
    ? keptRange(recipe, probe.video, input.totalFrames, input.frameTimes)
    : ({ ok: true, range: { fromSec: null, untilSec: null, frames: null } } as const);
  if (!ranged.ok) {
    return ranged;
  }
  const replace = recipe.audio === 'replace' ? input.track : null;
  if (recipe.audio === 'replace' && replace === null) {
    return { ok: false, message: 'Choose the replacement audio.' };
  }
  const kept = recipe.audio === 'keep' ? probe.audio : [];
  const carried = kept.filter((stream) => stream.codec !== null || carriesUndecodable(container));
  const bisected = BISECTED_CONTAINERS.includes(probe.info.container);
  const timing = timingOf(ranged.range, probe, {
    exact,
    keyframe: input.keyframe,
    bounded: replace !== null,
    audio: replace !== null || carried.length > 0,
    bisected,
    originSec: bisected
      ? Math.min(
          probe.video.startSec,
          ...(recipe.audio === 'keep' ? probe.audio : []).map(
            (stream) => stream.startSec ?? probe.formatStartSec,
          ),
        )
      : probe.formatStartSec,
    seekLeadSec:
      probe.bFrames && !PTS_SEEKING_CONTAINERS.includes(probe.info.container)
        ? DTS_SEEK_LEAD_SEC
        : 0,
  });

  const video = exact
    ? videoEncoderArgs(probe, container, input.encoders, input.features)
    : ({ ok: true, args: copyVideoArgs(probe) } as const);
  if (!video.ok) {
    return video;
  }
  const audio =
    recipe.audio === 'remove'
      ? ({ ok: true, args: ['-an'] } as const)
      : audioArgs(
          replace === null ? carried.map(audioOutput) : [{ ...replace, undecodable: false }],
          exact || replace !== null,
          // Looped too: the soundtrack starts over a whole number of times (see `loopsToLast`).
          replace !== null,
          container,
          input.encoders,
        );
  if (!audio.ok) {
    return audio;
  }
  const sameContainer =
    container === (probe.info.container === 'qt' ? 'mov' : probe.info.container);
  const subtitles = sameContainer
    ? probe.subtitles.filter((stream) => COPYABLE_SUBTITLES[container].includes(stream.codec))
    : [];
  const fonts = container === 'mkv' && subtitles.length > 0 ? probe.fonts : [];

  const args: string[] = [];
  if (generatesTimes(recipe, probe)) {
    // Exact cuts decode the video, which needs no presentation times.
    args.push('-fflags', '+genpts');
  }
  if (timing.seekSec !== null) {
    args.push('-ss', seconds(timing.seekSec));
  }
  if (timing.inputOffsetSec !== null) {
    args.push('-itsoffset', seconds(timing.inputOffsetSec));
  }
  args.push('-i', input.source);
  if (replace !== null) {
    // The output seek applies to every input: the soundtrack is shifted to make up for it.
    const offset =
      timing.outputSeekSec === null ? [] : ['-itsoffset', seconds(timing.outputSeekSec)];
    const loop = recipe.loop
      ? ['-stream_loop', String(loopsToLast(timing.lengthSec, replace.durationSec))]
      : [];
    args.push(...offset, ...loop, '-i', replace.path);
  }
  // Explicit maps: never cover art, data or timecode tracks.
  args.push('-map', `0:${probe.video.index}`);
  if (replace !== null) {
    args.push('-map', '1:a:0');
  } else {
    args.push(...carried.flatMap((stream) => ['-map', `0:${stream.index}`]));
  }
  args.push(...subtitles.flatMap((stream) => ['-map', `0:${stream.index}`]));
  args.push(...fonts.flatMap((index) => ['-map', `0:${index}`]));
  args.push('-map_metadata', '0', '-map_chapters', '0', '-dn');
  args.push(...video.args, ...audio.args);
  if (subtitles.length > 0) {
    args.push('-c:s', 'copy');
  }
  if (fonts.length > 0) {
    args.push('-c:t', 'copy');
  }
  if (timing.outputSeekSec !== null) {
    args.push('-ss', seconds(timing.outputSeekSec));
  }
  if (timing.frames !== null) {
    args.push('-frames:v', String(timing.frames));
  }
  if (timing.lengthSec !== null) {
    args.push('-t', seconds(timing.lengthSec));
  }
  if (timing.zeroTimestamps) {
    args.push('-avoid_negative_ts', 'make_zero');
  }
  if (MUXERS[container] === 'mp4' || container === 'mov') {
    // The MOV muxer recreates a timecode track from the video's timecode tag otherwise.
    args.push('-write_tmcd', '0');
  }
  args.push('-f', MUXERS[container], input.output);
  return {
    ok: true,
    plan: {
      args,
      durationSec: Math.max(0, timing.durationSec),
      droppedAudio: kept.filter((stream) => !carried.includes(stream)).map(({ index }) => index),
    },
  };
}

/**
 * How many times a soundtrack of `trackSec` starts over to last `lengthSec`: as many as that takes,
 * and no more, as ffmpeg 6.0 never exits when the result ends while a looped input would start over
 * again. What rounding leaves at the end is padded with silence. `-1` (forever) when unbounded.
 */
function loopsToLast(lengthSec: number | null, trackSec: number): number {
  return lengthSec === null || trackSec <= 0
    ? -1
    : Math.max(0, Math.ceil(lengthSec / trackSec - FRAME_EPSILON) - 1);
}

/**
 * Whether a container takes audio that ffmpeg cannot decode, copied as it is. Only MOV does, by
 * the source's own sample entry: MP4 and Matroska refuse a codec ffmpeg does not know. A MOV result
 * only comes from a MOV source, such as an iPhone video with its spatial audio track.
 */
function carriesUndecodable(container: OutputContainer): boolean {
  return container === 'mov';
}

/** Arguments for a stream copy of the video. */
function copyVideoArgs(probe: MediaProbe): readonly string[] {
  return [
    ...['-c:v', 'copy'],
    // DivX and Xvid in AVI store B-frames packed with the frame before (and an empty frame after),
    // which is not valid MPEG-4 elsewhere. Unpacked streams go through unchanged.
    ...(probe.video.codec === 'mpeg4' ? ['-bsf:v', 'mpeg4_unpack_bframes'] : []),
  ];
}

type ArgsResult =
  | { readonly ok: true; readonly args: readonly string[] }
  | { readonly ok: false; readonly message: string };

/** Pixel formats every H.264 decoder takes: 8-bit 4:2:0. */
const PLAYABLE_PIXEL_FORMATS: readonly (string | null)[] = ['yuv420p', 'yuvj420p', 'nv12', 'nv21'];

function videoEncoderArgs(
  probe: MediaProbe,
  container: OutputContainer,
  encoders: ReadonlySet<string>,
  features: MediaFeatures,
): ArgsResult {
  if (features.demuxTimeBase === null) {
    // The app refuses such an ffmpeg before any run (see `isSupported`).
    return {
      ok: false,
      message: 'This ffmpeg is too old to cut exactly: update it, or choose fast cuts.',
    };
  }
  const candidates = familiesFor(probe.video.codec)
    .filter((family) => ACCEPTED_VIDEO[container].includes(family))
    .flatMap((family) => VIDEO_ENCODERS[family].map((encoder) => ({ family, encoder })));
  const chosen = candidates.find(({ encoder }) => encoders.has(encoder.name));
  if (chosen === undefined) {
    const names = candidates.map(({ encoder }) => encoder.name).join(', ');
    return {
      ok: false,
      message: `Exact cuts re-encode the video, and this ffmpeg has no suitable encoder (${names}). Choose fast cuts, or install a complete ffmpeg build.`,
    };
  }
  const { family, encoder } = chosen;
  const { codec, pixFmt, fieldOrder } = probe.video;
  const bitRate = probe.video.bitRate ?? probe.formatBitRate ?? DEFAULT_BIT_RATE;
  const args = [
    ...encoder.args(bitRate, container),
    // Frames keep their timestamps as the source has them. ffmpeg would round them onto a grid of
    // the frame rate it guessed: frames of a variable frame rate video would collide and be
    // dropped, and `-t` would end the cut up to half a frame off.
    ...['-enc_time_base:v', features.demuxTimeBase],
    // And none is dropped or duplicated to keep a constant rate, which ffmpeg does by default for
    // MP4 and MOV. On that fine time grid, ffmpeg 6.1 would duplicate each frame thousands of times.
    ...fpsModeArgs(features, 'passthrough'),
  ];
  const filters: string[] = [];
  // Interlaced video keeps its fields where the encoder can code them (x264), in their order,
  // which x264 writes in the stream for players. Elsewhere it is deinterlaced, one frame per frame
  // (cuts and frame counts stay as they are): stored as progressive, woven fields would comb.
  const interlaced = fieldOrder !== null && encoder.name === 'libx264';
  if (interlaced) {
    args.push('-flags', '+ildct+ilme', '-x264-params', fieldOrder === 'tff' ? 'tff=1' : 'bff=1');
  } else if (fieldOrder !== null) {
    filters.push(`bwdif=mode=send_frame:parity=${fieldOrder}`);
  }
  // H.264 that plays everywhere is 8-bit 4:2:0. A ProRes, DNxHD, MJPEG or RGB source would make
  // x264 keep its 4:2:2 or 4:4:4 (High 4:2:2 or 4:4:4 profiles, which common players refuse), and
  // the OS encoders take 4:2:0 only. An H.264 source that x264 re-encodes stays as it was.
  if (
    family === 'h264' &&
    (codec !== 'h264' || encoder.name !== 'libx264') &&
    !PLAYABLE_PIXEL_FORMATS.includes(pixFmt)
  ) {
    // Full-range (JPEG) video stays full-range with x264, which marks it so in the stream: said
    // outright, as ffmpeg 6.1 and older would squeeze it into the limited range of yuv420p.
    const fullRange = probe.video.fullRange && encoder.name === 'libx264';
    const scale = [
      // Chroma is shared within each field, not across them.
      ...(interlaced ? ['interl=1'] : []),
      ...(fullRange ? ['out_range=pc'] : []),
    ];
    if (scale.length > 0) {
      filters.push(`scale=${scale.join(':')}`);
    }
    args.push('-pix_fmt', 'yuv420p', ...(fullRange ? ['-color_range', 'pc'] : []));
  }
  if (filters.length > 0) {
    args.push('-filter:v', filters.join(','));
  }
  return { ok: true, args };
}

/** An audio stream of the output. */
interface AudioOutput {
  readonly channels: number;
  readonly layout: string | null;
  /** Copied as it is, even when the others are encoded: ffmpeg cannot decode it. */
  readonly undecodable: boolean;
}

function audioOutput(stream: AudioStream): AudioOutput {
  return { channels: stream.channels, layout: stream.layout, undecodable: stream.codec === null };
}

/**
 * `streams`: the audio streams of the output. Copied when nothing forces encoding; encoded
 * otherwise, in AAC (Opus for WebM), padded with silence to the end when `pad`.
 */
function audioArgs(
  streams: readonly AudioOutput[],
  encode: boolean,
  pad: boolean,
  container: OutputContainer,
  encoders: ReadonlySet<string>,
): ArgsResult {
  if (streams.length === 0) {
    return { ok: true, args: [] };
  }
  if (!encode || streams.every(({ undecodable }) => undecodable)) {
    return { ok: true, args: ['-c:a', 'copy'] };
  }
  const candidates = container === 'webm' ? WEBM_AUDIO_ENCODERS : AAC_ENCODERS;
  const encoder = candidates.find((candidate) => encoders.has(candidate.name));
  if (encoder === undefined) {
    const names = candidates.map((candidate) => candidate.name).join(', ');
    return { ok: false, message: `This ffmpeg has no encoder for the audio (${names}).` };
  }
  const args = ['-c:a', encoder.name];
  streams.forEach(({ channels, layout, undecodable }, index) => {
    if (undecodable) {
      // After the general `-c:a`, which it overrides for this stream.
      args.push(`-c:a:${index}`, 'copy');
      return;
    }
    args.push(`-b:a:${index}`, encoder.bitRate(channels));
    const accepted = layout !== null && (encoder.layouts?.includes(layout) ?? true);
    const standard = STANDARD_LAYOUTS[Math.min(channels, STANDARD_LAYOUTS.length) - 1] ?? 'stereo';
    const filters = [
      // Encoders refuse channels in an unknown order: give them the usual one. aresample takes the
      // stream as decoded first: ffmpeg 5.1 to 6.1 would expect the new layout from the decoder,
      // and fail on its first frame.
      ...(accepted ? [] : [`aresample,aformat=channel_layouts=${standard}`]),
      ...(pad ? ['apad'] : []),
    ];
    if (filters.length > 0) {
      args.push(`-filter:a:${index}`, filters.join(','));
    }
  });
  return { ok: true, args };
}

/** A timestamp for the command line, in seconds. */
function seconds(value: number): string {
  return Math.max(0, value).toFixed(6);
}
