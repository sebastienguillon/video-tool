/** Parsing and formatting of the lengths typed in the trim fields and shown in the lists. */

const TIME = /^(?:(?:(\d+):)?(\d+):)?(\d+(?:[.,]\d*)?|[.,]\d+)\s*s?$/i;

/**
 * Reads a length of time typed by the user, in seconds: `2`, `2.5` (or `2,5`), `2.5s`, `1:02.5`
 * (minutes:seconds) or `1:02:03.25` (hours:minutes:seconds). An empty field is `0`. Returns `null`
 * when the text is not a length: negative, malformed, or with 60 or more minutes or seconds where a
 * larger unit is given.
 */
export function parseTime(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') {
    return 0;
  }
  const match = TIME.exec(trimmed);
  if (!match) {
    return null;
  }
  const [, hoursText, minutesText, secondsText = ''] = match;
  const hours = hoursText === undefined ? 0 : Number(hoursText);
  const minutes = minutesText === undefined ? 0 : Number(minutesText);
  const seconds = Number(secondsText.replace(',', '.'));
  if (minutesText !== undefined && seconds >= 60) {
    return null;
  }
  if (hoursText !== undefined && minutes >= 60) {
    return null;
  }
  const total = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) ? total : null;
}

/** Reads a number of frames typed by the user: a whole number. An empty field is `0`. */
export function parseFrames(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') {
    return 0;
  }
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const frames = Number(trimmed);
  return Number.isSafeInteger(frames) ? frames : null;
}

/**
 * A length for a trim field, as `parseTime` reads it back: `2.5`, `1:02.25`, `1:00:00`. At most
 * three decimals (milliseconds), without trailing zeros.
 */
export function formatTime(seconds: number): string {
  const millis = Math.round(Math.max(0, seconds) * 1000);
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor((millis % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((millis % 60_000) / 1000);
  const fraction = millis % 1000;
  const decimals = fraction === 0 ? '' : `.${String(fraction).padStart(3, '0').replace(/0+$/, '')}`;
  if (hours === 0 && minutes === 0) {
    return `${wholeSeconds}${decimals}`;
  }
  const secondsPart = `${String(wholeSeconds).padStart(2, '0')}${decimals}`;
  return hours === 0
    ? `${minutes}:${secondsPart}`
    : `${hours}:${String(minutes).padStart(2, '0')}:${secondsPart}`;
}

/** A duration as a clock, rounded to the second: `0:05`, `12:34`, `1:02:03`. */
export function formatDuration(seconds: number): string {
  const total = Math.round(Math.max(0, seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return hours === 0
    ? `${minutes}:${secs}`
    : `${hours}:${String(minutes).padStart(2, '0')}:${secs}`;
}

/** A frame rate for display: `30`, `29.97`, `23.976`. */
export function formatFrameRate(fps: number): string {
  return String(Math.round(fps * 1000) / 1000);
}
