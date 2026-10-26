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

/** Whether the video stream is re-encoded: only for exact cuts. Otherwise it is copied as is. */
export function reencodesVideo(recipe: Recipe): boolean {
  return recipe.precision === 'exact' && trims(recipe);
}

/** A recipe that keeps the audio and trims nothing would only copy the file. */
export function changesNothing(recipe: Recipe): boolean {
  return recipe.audio === 'keep' && !trims(recipe);
}

/**
 * What the name of a result says was done to it, in a fixed order: `clip (no audio, trimmed).mp4`.
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
  return labels;
}

/** Seconds a trim removes from `info`; `null` for frames when the frame rate is unknown. */
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
 * Why the recipe cannot run at all, whatever the video; `null` when it can. `track` is the audio
 * list entry of `recipe.trackId`, `null` when there is none.
 */
export function recipeIssue(recipe: Recipe, track: AudioTrack | null): string | null {
  // Before `changesNothing`: an invalid length is not "no trim".
  if (!Number.isFinite(recipe.trimStart.amount) || !Number.isFinite(recipe.trimEnd.amount)) {
    return 'Enter valid lengths to trim.';
  }
  if (recipe.trimStart.amount < 0 || recipe.trimEnd.amount < 0) {
    return 'Lengths to trim cannot be negative.';
  }
  for (const trim of [recipe.trimStart, recipe.trimEnd]) {
    if (trim.unit === 'frames' && !Number.isInteger(trim.amount)) {
      return 'Frames to trim must be whole numbers.';
    }
  }
  if (changesNothing(recipe)) {
    return 'Choose what to do: remove or replace the audio, or trim.';
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
  if (
    info.frameRate === null &&
    [recipe.trimStart, recipe.trimEnd].some((trim) => trim.unit === 'frames' && isTrimSet(trim))
  ) {
    return 'Its frame rate is unknown: trim it in seconds.';
  }
  const remaining = outputDuration(recipe, info);
  // Half a frame of tolerance for frame counts converted to seconds.
  const minimum = info.frameRate === null ? 0.001 : 0.5 / info.frameRate;
  if (remaining !== null && remaining < minimum) {
    return `The trims remove all of it (${formatDuration(info.durationSec)} long).`;
  }
  return null;
}
