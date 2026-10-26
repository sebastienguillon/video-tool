import { createLogger } from '@shared/log';
import { FOLDER_FILE_LIMIT } from '@shared/model';
import type { BigIntStats, Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const log = createLogger('video-files');

/** macOS and Windows volumes are case-insensitive by default. */
const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';

/** Windows system folders: hidden there, but without a leading dot. */
const SYSTEM_FOLDERS = new Set(['$recycle.bin', 'system volume information']);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Orders names as file managers do: "clip 2" before "clip 10", case and accents aside. Names equal
 * that way still get a stable order.
 */
export function naturalCompare(a: string, b: string): number {
  const order = collator.compare(a, b);
  if (order !== 0 || a === b) {
    return order;
  }
  return a < b ? -1 : 1;
}

/** Lowercase, without the dot; `''` when there is none. */
export function extensionOf(file: string): string {
  return path.extname(file).slice(1).toLowerCase();
}

/**
 * Identity of a file for duplicate checks: resolved, Unicode NFC (macOS may hand back decomposed
 * names), and of any case where volumes ignore it.
 */
export function pathKey(file: string, insensitive = caseInsensitive): string {
  const resolved = path.resolve(file).normalize('NFC');
  return insensitive ? resolved.toLowerCase() : resolved;
}

/**
 * The files and folders a launch asks to open ("Open with", files dropped on the app's icon):
 * Chromium switches dropped, `file:` URLs (Linux desktop entries) turned into paths, relative paths
 * resolved against `cwd`. `args` excludes the executable.
 */
export function launchPaths(args: readonly string[], cwd: string): string[] {
  const paths: string[] = [];
  for (const arg of args) {
    if (arg === '' || arg.startsWith('-')) {
      continue;
    }
    if (!arg.startsWith('file:')) {
      paths.push(path.resolve(cwd, arg));
      continue;
    }
    try {
      paths.push(fileURLToPath(arg));
    } catch {
      // A URL of another computer (`file://host/…` off Windows): not a local file.
    }
  }
  return paths;
}

export interface ExpandOptions {
  /** Accepted extensions, without the dot, in any case. */
  readonly extensions: readonly string[];
  /** Whether a folder adds the accepted files below it, or counts as ignored. */
  readonly folders: boolean;
  /** Most files taken from folders; `FOLDER_FILE_LIMIT` by default. */
  readonly limit?: number;
}

export interface Expansion {
  /** Absolute paths of the accepted files, without duplicates, in the order to list them. */
  readonly files: readonly string[];
  /**
   * Paths given that bring nothing: missing, relative, of another type, or a folder without any
   * accepted file. Other files inside folders are not counted: dropping a folder means "its videos".
   */
  readonly ignored: number;
  /** Folders held more accepted files than the limit: the rest was left out. */
  readonly truncated: boolean;
}

/**
 * Turns dropped or chosen paths into the files to add. A file given is kept when its extension is
 * accepted (even a hidden one: it was picked on purpose). Folders are walked depth-first, each
 * one's files before its subfolders, both in natural order. Hidden entries are skipped, and
 * symbolic links to folders (Windows junctions too) are not followed, so no walk can loop.
 */
export async function expandPaths(
  paths: readonly string[],
  { extensions, folders, limit = FOLDER_FILE_LIMIT }: ExpandOptions,
): Promise<Expansion> {
  const accepted = new Set(extensions.map((extension) => extension.toLowerCase()));
  const files: string[] = [];
  const seen = new Set<string>();
  // Folders walked, by device and inode: one can be given along with its parent.
  const walked = new Set<string>();
  // Updated by `walk`, read after each await.
  const budget = { left: limit, exhausted: false };

  /** Returns how many accepted files are below `dir`, already listed ones included. */
  const walk = async (dir: string, stats: BigIntStats): Promise<number> => {
    walked.add(folderId(dir, stats));
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable (permissions, a drive gone): skipped like a hidden folder.
      return 0;
    }
    const visible = entries
      .filter((entry) => !isHiddenName(entry.name))
      .sort((a, b) => naturalCompare(a.name, b.name));
    let found = 0;
    const subfolders: string[] = [];
    for (const entry of visible) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        subfolders.push(entryPath);
        continue;
      }
      if (!accepted.has(extensionOf(entry.name))) {
        continue;
      }
      // A link to a file stands for that file; a dangling one, or one to a folder, is skipped.
      const isFile = entry.isSymbolicLink()
        ? (await statOrNull(entryPath))?.isFile() === true
        : entry.isFile();
      if (!isFile) {
        continue;
      }
      if (budget.left === 0) {
        budget.exhausted = true;
        log.warn(`Stopped at ${limit.toLocaleString('en')} files from folders, in ${dir}`);
        return found + 1;
      }
      found++;
      const key = pathKey(entryPath);
      if (!seen.has(key)) {
        seen.add(key);
        files.push(entryPath);
        budget.left--;
      }
    }
    for (const subfolder of subfolders) {
      const subStats = await statOrNull(subfolder);
      if (subStats?.isDirectory() === true && !walked.has(folderId(subfolder, subStats))) {
        found += await walk(subfolder, subStats);
      }
      if (budget.exhausted) {
        break;
      }
    }
    return found;
  };

  let ignored = 0;
  for (const input of paths) {
    const target = input !== '' && path.isAbsolute(input) ? path.resolve(input) : null;
    const stats = target === null ? null : await statOrNull(target);
    if (target === null || stats === null) {
      ignored++;
    } else if (stats.isFile()) {
      const key = pathKey(target);
      if (!accepted.has(extensionOf(target))) {
        ignored++;
      } else if (!seen.has(key)) {
        seen.add(key);
        files.push(target);
      }
    } else if (!stats.isDirectory() || !folders) {
      ignored++;
    } else if (
      // Past the limit, further folders are left out without a look: not ignored, just not added.
      !budget.exhausted &&
      !walked.has(folderId(target, stats)) &&
      (await walk(target, stats)) === 0
    ) {
      ignored++;
    }
  }
  return { files, ignored, truncated: budget.exhausted };
}

function isHiddenName(name: string): boolean {
  return name.startsWith('.') || SYSTEM_FOLDERS.has(name.toLowerCase());
}

/** Device and inode; the path where the volume has no inodes (FAT, some network shares report 0). */
function folderId(dir: string, stats: BigIntStats): string {
  return stats.ino === 0n ? pathKey(dir) : `${String(stats.dev)}:${String(stats.ino)}`;
}

/** Follows symbolic links. BigInt stats: Windows file ids do not fit in a double. */
async function statOrNull(file: string): Promise<BigIntStats | null> {
  try {
    return await stat(file, { bigint: true });
  } catch {
    return null;
  }
}
