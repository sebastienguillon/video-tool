/**
 * The suffix of a soundtrack (`AudioTrack.suffix`), as both sides work it out: the main process
 * keeps it, and the renderer shows what an empty field stands for.
 */

/**
 * Longest suffix, in UTF-8 bytes. With the other labels, a copy number and the extension, a result's
 * name keeps more than 100 bytes for the name of its video, of the 255 file systems allow.
 */
export const MAX_SUFFIX_BYTES = 120;

/** What `trackSuffix` falls back to when even the file name leaves nothing. */
const LAST_RESORT = 'new audio';

const encoder = new TextEncoder();

/**
 * What the name of a result says of the soundtrack `fileName` (its name, with its extension) when
 * it replaced the audio: `text`, where what file names cannot hold on Windows, macOS or Linux
 * (`<>:"/\|?*` and control characters) becomes a space, and without the direction marks that would
 * show the end of the name reversed; white space collapsed and trimmed, and at most
 * `MAX_SUFFIX_BYTES` long. When that leaves nothing, or `text` is not a string: `fileName` without
 * its extension, cleaned the same way; and when that leaves nothing either, `new audio`.
 */
export function trackSuffix(text: unknown, fileName: string): string {
  const chosen = typeof text === 'string' ? cleanSuffix(text) : '';
  if (chosen !== '') {
    return chosen;
  }
  const name = cleanSuffix(stemOf(fileName));
  return name !== '' ? name : LAST_RESORT;
}

/** A file name without its extension, as Node's `path.parse` has it: `.mp3` has none. */
function stemOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

function cleanSuffix(text: string): string {
  const clean = text
    .replace(/[\p{Cc}<>:"/\\|?*]/gu, ' ')
    .replace(/[؜‎‏‪-‮⁦-⁩]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (byteLength(clean) <= MAX_SUFFIX_BYTES) {
    return clean;
  }
  // By whole characters: accents and emoji stay intact.
  let kept = '';
  for (const { segment } of new Intl.Segmenter().segment(clean)) {
    if (byteLength(kept + segment) > MAX_SUFFIX_BYTES) {
      break;
    }
    kept += segment;
  }
  return kept.trimEnd();
}

/** UTF-8 bytes, a lone surrogate counting as the 3 of the U+FFFD it is written as. */
function byteLength(text: string): number {
  return encoder.encode(text).length;
}
