/**
 * What a recipe does to a video, as both sides see it: the renderer warns before a run, and the
 * main process refuses the same cases when it plans the ffmpeg command.
 */
import type { AudioTrack, Recipe, Trim, VideoInfo } from './model';
import { formatDuration } from './time';

export function isTrimSet(trim: Trim): boolean {
  return trim.amount > 0;
}

export function trims(recipe: Recipe): boolean {
  return isTrimSet(recipe.trimStart) || isTrimSet(recipe.trimEnd);
}

/** Whether the audio of the result, kept or new, is muted at its start or its end. */
export function silences(recipe: Recipe): boolean {
  return (
    recipe.audio !== 'remove' && (isTrimSet(recipe.silenceStart) || isTrimSet(recipe.silenceEnd))
  );
}

/** Whether the video stream is re-encoded: only for exact cuts. Otherwise it is copied as is. */
export function reencodesVideo(recipe: Recipe): boolean {
  return recipe.precision === 'exact' && trims(recipe);
}

/** A recipe that keeps the audio as it is and trims nothing would only copy the file. */
export function changesNothing(recipe: Recipe): boolean {
  return recipe.audio === 'keep' && !trims(recipe) && !silences(recipe);
}

/**
 * What the name of a result says was done to it, in a fixed order: `clip (no audio, trimmed).mp4`,
 * `clip (trimmed, muted).mp4`.
 * A replaced audio is named by `trackSuffix`, the suffix of the soundtrack (`clip (Beach waves).mp4`),
 * or `new audio` without one. Empty for a recipe that changes nothing.
 */
export function outputLabels(recipe: Recipe, trackSuffix: string | null): string[] {
  const labels: string[] = [];
  if (recipe.audio === 'remove') {
    labels.push('no audio');
  } else if (recipe.audio === 'replace') {
    labels.push(trackSuffix ?? 'new audio');
  }
  if (trims(recipe)) {
    labels.push('trimmed');
  }
  if (silences(recipe)) {
    labels.push('muted');
  }
  return labels;
}

/**
 * Seconds a length lasts in `info`, to trim or to silence; `null` for frames when the frame rate is
 * unknown.
 */
export function trimSeconds(trim: Trim, info: VideoInfo): number | null {
  if (trim.unit === 'seconds') {
    return trim.amount;
  }
  if (trim.amount === 0) {
    return 0;
  }
  return info.frameRate === null ? null : trim.amount / info.frameRate;
}

/** Length of the result, in seconds; `null` when a frame trim cannot be converted. */
export function outputDuration(recipe: Recipe, info: VideoInfo): number | null {
  const start = trimSeconds(recipe.trimStart, info);
  const end = trimSeconds(recipe.trimEnd, info);
  return start === null || end === null ? null : info.durationSec - start - end;
}

/**
 * Seconds of the result whose audio is muted, the start and the end together; `null` when a length
 * in frames cannot be converted.
 */
export function silencedDuration(recipe: Recipe, info: VideoInfo): number | null {
  if (!silences(recipe)) {
    return 0;
  }
  const start = trimSeconds(recipe.silenceStart, info);
  const end = trimSeconds(recipe.silenceEnd, info);
  return start === null || end === null ? null : start + end;
}

/** Why lengths typed by the user cannot be used; `null` when they can. */
function lengthIssue(lengths: readonly Trim[], purpose: 'trim' | 'silence'): string | null {
  if (lengths.some((length) => !Number.isFinite(length.amount))) {
    return `Enter valid lengths to ${purpose}.`;
  }
  if (lengths.some((length) => length.amount < 0)) {
    return `Lengths to ${purpose} cannot be negative.`;
  }
  if (lengths.some((length) => length.unit === 'frames' && !Number.isInteger(length.amount))) {
    return `Frames to ${purpose} must be whole numbers.`;
  }
  return null;
}

/**
 * Why the recipe cannot run at all, whatever the video; `null` when it can. `track` is the audio
 * list entry of `recipe.trackId`, `null` when there is none.
 */
export function recipeIssue(recipe: Recipe, track: AudioTrack | null): string | null {
  // Before `changesNothing`: an invalid length is not "no trim". Silences of a removed audio are
  // unused, whatever they are.
  const issue =
    lengthIssue([recipe.trimStart, recipe.trimEnd], 'trim') ??
    (recipe.audio === 'remove'
      ? null
      : lengthIssue([recipe.silenceStart, recipe.silenceEnd], 'silence'));
  if (issue !== null) {
    return issue;
  }
  if (changesNothing(recipe)) {
    return 'Choose what to do: remove or replace the audio, silence or trim.';
  }
  if (recipe.audio === 'replace') {
    if (recipe.trackId === null || track === null) {
      return 'Choose the replacement audio.';
    }
    switch (track.status) {
      case 'missing':
        return `${track.name} is missing: it was moved or deleted.`;
      case 'unreadable':
        return `${track.name} cannot be read as audio.`;
      case 'probing':
      case 'ok':
        break;
    }
  }
  return null;
}

/** Why the recipe cannot apply to this video; `null` when it can. */
export function videoIssue(recipe: Recipe, info: VideoInfo): string | null {
  const inFrames = (length: Trim) => length.unit === 'frames' && isTrimSet(length);
  if (info.frameRate === null && [recipe.trimStart, recipe.trimEnd].some(inFrames)) {
    return 'Its frame rate is unknown: trim it in seconds.';
  }
  const silencing = silences(recipe);
  if (
    info.frameRate === null &&
    silencing &&
    [recipe.silenceStart, recipe.silenceEnd].some(inFrames)
  ) {
    return 'Its frame rate is unknown: silence it in seconds.';
  }
  const remaining = outputDuration(recipe, info);
  // Half a frame of tolerance for frame counts converted to seconds.
  const minimum = info.frameRate === null ? 0.001 : 0.5 / info.frameRate;
  if (remaining !== null && remaining < minimum) {
    return `The trims remove all of it (${formatDuration(info.durationSec)} long).`;
  }
  if (!silencing) {
    return null;
  }
  if (recipe.audio === 'keep' && info.audioCodec === null) {
    // Silences of a video without audio are left out: it may still be trimmed.
    return trims(recipe) ? null : 'It has no audio to silence.';
  }
  const silenced = silencedDuration(recipe, info);
  if (remaining !== null && silenced !== null && remaining - silenced < minimum) {
    return coveredBySilences(remaining, trims(recipe));
  }
  return null;
}

/** Why silences that leave no sound are refused: the result lasts `durationSec`. */
export function coveredBySilences(durationSec: number, trimmed: boolean): string {
  const length = `${formatDuration(durationSec)} long${trimmed ? ' once trimmed' : ''}`;
  return `The silences cover all of it (${length}): remove the audio instead.`;
}
