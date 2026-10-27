import { createLogger } from '@shared/log';
import type { OutputSettings, Recipe, Trim } from '@shared/model';
import { changesNothing, isTrimSet, outputLabels, reencodesVideo, silences } from '@shared/recipe';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage } from './exec';
import type { MediaTools } from './media-tools';
import {
  errorCode,
  outputName,
  partialName,
  publishOutput,
  removeFile,
  removeFileSync,
} from './output-files';
import type { AudioTrackInput, FrameTimes } from './plan';
import {
  appliedRecipe,
  framesToScan,
  generatesTimes,
  keyframeLookup,
  outputContainer,
  planJob,
} from './plan';
import type { FrameScan, Keyframe, MediaProbe } from './probe';
import {
  findKeyframe,
  firstFrame,
  probeAudioTrack,
  scanFrames,
  UnsupportedMediaError,
} from './probe';
import type { Progress } from './runner';
import { CanceledError, runFfmpeg } from './runner';

const log = createLogger('job');

/** The job cannot be done; `message` is for the user. */
export class JobError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'JobError';
  }
}

/** The soundtrack that replaces the audio, and what the result's name says of it. */
export interface ReplacementTrack {
  readonly path: string;
  /** See `AudioTrack.suffix`. */
  readonly suffix: string;
}

export interface JobInput {
  readonly tools: MediaTools;
  readonly source: string;
  /** Of `source`, from when it was added. */
  readonly probe: MediaProbe;
  readonly recipe: Recipe;
  readonly output: OutputSettings;
  /** The replacement soundtrack, when `recipe.audio` is `replace`. */
  readonly track: ReplacementTrack | null;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: Progress) => void;
  /**
   * Given a function that undoes the job at once, blocking until done, while it has a partial file:
   * it kills ffmpeg and deletes the file. Then `null`. For when the app is about to exit without
   * waiting for the job to settle (see `Queue.abortNow`).
   */
  readonly onAbortNow?: (abortNow: (() => void) | null) => void;
}

/**
 * Applies a recipe to one video and resolves to the path of the result. ffmpeg writes a hidden
 * partial file in the destination folder, which gets its final name only once complete: the source
 * is only ever read, no existing file is replaced, and a failed or canceled job leaves nothing
 * behind. Rejects with a `JobError` or an `FfmpegError` (messages for the user), or a
 * `CanceledError`.
 */
export async function processVideo(input: JobInput): Promise<string> {
  const { tools, source, signal } = input;
  const recipe = appliedRecipe(input.recipe, input.probe);
  if (changesNothing(recipe) && silences(input.recipe)) {
    // Refused before the run already (see `videoIssue`).
    throw new JobError('It has no audio to silence.');
  }
  if (!(await isFile(source))) {
    throw new JobError('The video was moved or deleted.');
  }
  const dir = destinationOf(source, input.output);
  await checkFolder(dir);
  // Packets are read as the copy will read them: with the presentation times it works out.
  const genpts = generatesTimes(recipe, input.probe);
  const probe = await onCutTimeline(input, recipe, genpts);
  const scan = await framesOf(input, recipe, probe, genpts);
  const totalFrames = scan?.complete === true ? scan.count : probe.video.frameCount;
  const times = scan?.times ?? null;
  const frameTimes: FrameTimes | null =
    times === null ? null : { times, complete: scan?.complete === true };
  const lookup = keyframeLookup(recipe, probe, frameTimes);
  const keyframe = lookup === null ? null : await keyframeBefore(input, lookup, genpts);
  const track = recipe.audio === 'replace' ? await replacement(input) : null;
  if (signal.aborted) {
    throw new CanceledError();
  }

  const container = outputContainer(probe.info.container, reencodesVideo(recipe));
  const baseName = path.parse(source).name;
  const partial = path.join(dir, partialName(baseName, container, randomUUID().slice(0, 8)));
  if (samePath(partial, source)) {
    throw new Error(`Refusing to write over the source: ${source}`);
  }
  const planned = planJob({
    source,
    output: partial,
    probe,
    recipe,
    encoders: tools.encoders,
    features: tools.features,
    track,
    totalFrames,
    frameTimes,
    keyframe,
  });
  if (!planned.ok) {
    throw new JobError(planned.message);
  }
  const { droppedAudio } = planned.plan;
  if (droppedAudio.length > 0) {
    const reason = silences(recipe)
      ? 'so they cannot be silenced'
      : `and ${container.toUpperCase()} cannot hold them as they are`;
    log.warn(
      `Leaving out audio streams ${droppedAudio.join(', ')} of ${source}: ffmpeg cannot decode them, ${reason}.`,
    );
  }

  await reserve(partial, dir);
  let killNow: (() => void) | null = null;
  input.onAbortNow?.(() => {
    killNow?.();
    try {
      removeFileSync(partial);
    } catch (error) {
      log.warn(`Cannot delete ${partial}:`, errorMessage(error));
    }
  });
  try {
    const { frames } = await runFfmpeg(tools.ffmpeg, planned.plan.args, {
      durationSec: planned.plan.durationSec,
      signal,
      onProgress: input.onProgress,
      onKillNow: (kill) => {
        killNow = kill;
      },
    });
    if (frames === 0) {
      throw new JobError('Nothing is left of the video after the cuts.');
    }
    const labels = outputLabels(recipe, input.track?.suffix ?? null);
    return await publishOutput(partial, dir, (copy) =>
      outputName(baseName, labels, container, copy),
    ).catch((error: unknown) => {
      throw new JobError(`Cannot name the result in ${dir}: ${errorMessage(error)}`, {
        cause: error,
      });
    });
  } catch (error) {
    await removeFile(partial).catch((removeError: unknown) => {
      log.warn(`Cannot delete ${partial}:`, errorMessage(removeError));
    });
    throw error;
  } finally {
    input.onAbortNow?.(null);
  }
}

/** The folder the result goes to. */
export function destinationOf(source: string, output: OutputSettings): string {
  return output.location === 'folder' && output.folder !== null
    ? path.resolve(output.folder)
    : path.dirname(source);
}

async function checkFolder(dir: string): Promise<void> {
  try {
    if ((await stat(dir)).isDirectory()) {
      return;
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') {
      throw new JobError(`Cannot open the output folder ${dir}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }
  throw new JobError(`The output folder ${dir} does not exist.`);
}

/** Creates the partial file before ffmpeg runs: proves the folder writable, with a clear message. */
async function reserve(partial: string, dir: string): Promise<void> {
  try {
    await (await open(partial, 'wx')).close();
  } catch (error) {
    const code = errorCode(error);
    if (code === 'EACCES' || code === 'EPERM') {
      throw new JobError(`Cannot write in ${dir}: permission denied.`, { cause: error });
    }
    if (code === 'EROFS') {
      throw new JobError(`Cannot write in ${dir}: it is read-only.`, { cause: error });
    }
    if (code === 'ENOSPC') {
      throw new JobError(`Cannot write in ${dir}: the disk is full.`, { cause: error });
    }
    throw new JobError(`Cannot write in ${dir}: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * The frames that trims and silences in frames need (see `framesToScan`); `null` when none are
 * needed, or when the scan fails and the container's frame count, or the frame rate, will do.
 */
async function framesOf(
  input: JobInput,
  recipe: Recipe,
  probe: MediaProbe,
  genpts: boolean,
): Promise<FrameScan | null> {
  const { tools, source, signal } = input;
  const wanted = framesToScan(recipe, probe);
  if (wanted === null) {
    return null;
  }
  const scan = await scanFrames(
    tools,
    source,
    probe.video.index,
    wanted === 'all' ? null : wanted,
    {
      genpts,
      signal,
    },
  ).catch((error: unknown) => {
    rethrowIfCanceled(signal);
    log.warn(`Cannot read the frames of ${source}:`, errorMessage(error));
    return null;
  });
  const counted = scan !== null && scan.count > 0;
  // Without the times of its frames, a silence in frames goes by the frame rate.
  const inFrames = (length: Trim) => isTrimSet(length) && length.unit === 'frames';
  if (inFrames(recipe.trimEnd) && !counted && probe.video.frameCount === null) {
    throw new JobError('Its number of frames cannot be counted: trim its end in seconds.');
  }
  return counted ? scan : null;
}

/**
 * Exact cuts count frames from the first one as decoded, and go by the field order the decoded
 * frames have (see `firstFrame`).
 */
async function withFirstFrame(input: JobInput): Promise<MediaProbe> {
  const { tools, source, probe, signal } = input;
  const first = await firstFrame(tools, source, probe.video.index, signal).catch(
    (error: unknown) => {
      rethrowIfCanceled(signal);
      log.warn(`Cannot decode the first frame of ${source}:`, errorMessage(error));
      return null;
    },
  );
  if (first === null) {
    return probe;
  }
  const { fieldOrder } = probe.video;
  return {
    ...probe,
    video: {
      ...probe.video,
      startSec: first.startSec,
      // Interlaced as the stream says; frames that are not marked so do not tell the order.
      fieldOrder: fieldOrder === null ? null : (first.fieldOrder ?? fieldOrder),
    },
  };
}

/** The probe, with the video starting where the time line that the cut goes by says. */
async function onCutTimeline(
  input: JobInput,
  recipe: Recipe,
  genpts: boolean,
): Promise<MediaProbe> {
  if (reencodesVideo(recipe)) {
    return withFirstFrame(input);
  }
  return genpts ? withCopyStart(input) : input.probe;
}

/**
 * A copy that works out presentation times (see `generatesTimes`) counts frames from the first one
 * on its own time line: in AVI, a frame later than the stream's start says.
 */
async function withCopyStart(input: JobInput): Promise<MediaProbe> {
  const { tools, source, probe, signal } = input;
  const scan = await scanFrames(tools, source, probe.video.index, 1, {
    genpts: true,
    signal,
  }).catch((error: unknown) => {
    rethrowIfCanceled(signal);
    log.warn(`Cannot read the first frame of ${source}:`, errorMessage(error));
    return null;
  });
  const startSec = scan?.times?.[0];
  return startSec === undefined ? probe : { ...probe, video: { ...probe.video, startSec } };
}

/** `null` when it cannot be found: the copy then starts wherever ffmpeg's seek lands. */
async function keyframeBefore(
  input: JobInput,
  atSec: number,
  genpts: boolean,
): Promise<Keyframe | null> {
  const { tools, source, probe, signal } = input;
  return findKeyframe(tools, source, probe.video.index, atSec, { genpts, signal }).catch(
    (error: unknown) => {
      rethrowIfCanceled(signal);
      log.warn(`Cannot find the keyframes of ${source}:`, errorMessage(error));
      return null;
    },
  );
}

async function replacement(input: JobInput): Promise<AudioTrackInput> {
  const { track, signal } = input;
  if (track === null) {
    throw new JobError('Choose the replacement audio.');
  }
  const name = path.basename(track.path);
  if (!(await isFile(track.path))) {
    throw new JobError(`${name} is missing: it was moved or deleted.`);
  }
  try {
    const { durationSec, channels, layout } = await probeAudioTrack(
      input.tools,
      track.path,
      signal,
    );
    return { path: track.path, durationSec, channels, layout };
  } catch (error) {
    rethrowIfCanceled(signal);
    const reason = error instanceof UnsupportedMediaError ? ` ${error.message}` : '';
    throw new JobError(`${name} cannot be used as the new audio.${reason}`, { cause: error });
  }
}

function rethrowIfCanceled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CanceledError();
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    await access(file, constants.R_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Same file, as far as names tell: case-insensitive where the file system usually is. */
export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** Identity of a path for comparisons: resolved, Unicode-normalized, case-folded on Windows and macOS. */
export function pathKey(file: string): string {
  const resolved = path.resolve(file).normalize('NFC');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved;
}
