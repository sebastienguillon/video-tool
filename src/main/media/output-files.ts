import { createLogger } from '@shared/log';
import { rmSync } from 'node:fs';
import { link, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage } from './exec';

const log = createLogger('output-files');

/** Most file systems cap a name at 255 bytes (ext4, APFS) or 255 UTF-16 units (NTFS). */
const MAX_NAME_BYTES = 255;
/** A few antivirus scans of a fresh file: Windows refuses to rename it meanwhile. */
const RENAME_ATTEMPTS = 20;
const RETRY_DELAY_MS = 100;
const MAX_COPIES = 10_000;

/**
 * `clip (no audio, trimmed).mp4`, then `clip (no audio, trimmed) 2.mp4` for `copy` 2, and so on.
 * `baseName` is the source's name without its extension; it is shortened if the name gets too long.
 */
export function outputName(
  baseName: string,
  labels: readonly string[],
  extension: string,
  copy: number,
): string {
  return fitName(baseName, ` (${labels.join(', ')})${copy > 1 ? ` ${copy}` : ''}.${extension}`);
}

/**
 * Where ffmpeg writes until it succeeds: hidden on macOS and Linux, unique, and with the real
 * extension, which some tools go by.
 */
export function partialName(baseName: string, extension: string, id: string): string {
  return fitName(`.${baseName}`, `.partial-${id}.${extension}`);
}

/** Shortens `base` by whole characters (accents and emoji stay intact) until the name fits. */
function fitName(base: string, suffix: string): string {
  if (byteLength(base + suffix) <= MAX_NAME_BYTES) {
    return base + suffix;
  }
  const characters = Array.from(new Intl.Segmenter().segment(base), ({ segment }) => segment);
  while (characters.length > 1 && byteLength(characters.join('') + suffix) > MAX_NAME_BYTES) {
    characters.pop();
  }
  return characters.join('').trimEnd() + suffix;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Gives the finished file `partial` the first free name that `nameFor(copy)` proposes in `dir`, and
 * returns its path. Never replaces an existing file: a hard link fails when the name is taken,
 * even if another program created it a moment ago. File systems without hard links (FAT, exFAT,
 * some network shares) fall back to checking, then renaming.
 */
export async function publishOutput(
  partial: string,
  dir: string,
  nameFor: (copy: number) => string,
): Promise<string> {
  for (let copy = 1; copy <= MAX_COPIES; copy++) {
    const target = path.join(dir, nameFor(copy));
    if (await claim(partial, target)) {
      return target;
    }
  }
  throw new Error(`Every name for the result is taken in ${dir}.`);
}

async function claim(partial: string, target: string): Promise<boolean> {
  try {
    await link(partial, target);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      return false;
    }
    if (await exists(target)) {
      return false;
    }
    await renameWithRetries(partial, target);
    return true;
  }
  // The result is in place already; a leftover hidden name only wastes a directory entry.
  await removeFile(partial).catch((error: unknown) => {
    log.warn(`Cannot delete ${partial}:`, errorMessage(error));
  });
  return true;
}

/** Deletes a file if it is there. Windows may hold it briefly after the process that wrote it exits. */
export async function removeFile(file: string): Promise<void> {
  await rm(file, { force: true, maxRetries: 10, retryDelay: RETRY_DELAY_MS });
}

/**
 * `removeFile`, blocking: for when the app is about to exit. Waits less between attempts, a few
 * seconds at most in all: Windows does not wait long for an app that holds up the end of a session.
 */
export function removeFileSync(file: string): void {
  rmSync(file, { force: true, maxRetries: 10, retryDelay: RETRY_DELAY_MS / 2 });
}

async function renameWithRetries(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      const busy = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
      if (!busy || process.platform !== 'win32' || attempt >= RENAME_ATTEMPTS) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** The `code` of a Node system error, like `ENOENT`. */
export function errorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}
