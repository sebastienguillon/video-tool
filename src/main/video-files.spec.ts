import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { expandPaths, extensionOf, launchPaths, naturalCompare, pathKey } from './video-files';

const VIDEOS = { extensions: ['mp4', 'mkv', 'mov', 'webm'], folders: true } as const;

describe('naturalCompare', () => {
  it('orders numbers by value, ignoring case and accents', () => {
    expect(
      ['clip 10.mp4', 'Été.mp4', 'Clip 2.mp4', 'eta.mp4', 'clip 1.mp4'].sort(naturalCompare),
    ).toEqual(['clip 1.mp4', 'Clip 2.mp4', 'clip 10.mp4', 'eta.mp4', 'Été.mp4']);
  });

  it('still orders names that only differ by case, so that sorting is stable', () => {
    expect(naturalCompare('a.mp4', 'A.mp4')).not.toBe(0);
    expect(naturalCompare('a.mp4', 'A.mp4')).toBe(-naturalCompare('A.mp4', 'a.mp4'));
    expect(naturalCompare('a.mp4', 'a.mp4')).toBe(0);
  });
});

describe('extensionOf', () => {
  it('is lowercase, without the dot, and empty without an extension', () => {
    expect(extensionOf(path.join('Vidéos', 'Clip.MP4'))).toBe('mp4');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('README')).toBe('');
    expect(extensionOf('.mp4')).toBe('');
  });
});

describe('pathKey', () => {
  it('ignores case only where volumes do, and Unicode normalization always', () => {
    const composed = path.resolve('Été', 'clip.mp4');
    const decomposed = composed.normalize('NFD');
    expect(pathKey(decomposed, false)).toBe(pathKey(composed, false));
    expect(pathKey(composed.toUpperCase(), true)).toBe(pathKey(composed, true));
    expect(pathKey(composed.toUpperCase(), false)).not.toBe(pathKey(composed, false));
  });
});

describe('launchPaths', () => {
  it('keeps the paths, resolved, and drops Chromium switches', () => {
    const cwd = path.resolve('work', 'Vidéos 日本');
    const absolute = path.resolve('elsewhere', 'clip.mp4');
    expect(
      launchPaths(['--allow-file-access-from-files', 'clip 1.mp4', '', absolute, '-psn_0_42'], cwd),
    ).toEqual([path.join(cwd, 'clip 1.mp4'), absolute]);
  });

  it('turns file URLs into paths', () => {
    const file = path.resolve('Vidéos', 'clip 1.mp4');
    expect(launchPaths([pathToFileURL(file).href], process.cwd())).toEqual([file]);
  });
});

describe('expandPaths', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'video-tool-files-'));
  const at = (...segments: string[]): string => path.join(root, ...segments);
  const write = (...segments: string[]): string => {
    const file = at(...segments);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
    return file;
  };

  const library = at('Vidéos 日本');
  write('Vidéos 日本', 'clip 10.MP4');
  write('Vidéos 日本', 'clip 2.mp4');
  write('Vidéos 日本', 'notes.txt');
  write('Vidéos 日本', '.hidden.mp4');
  write('Vidéos 日本', '.git', 'inside.mp4');
  write('Vidéos 日本', '$RECYCLE.BIN', 'deleted.mp4');
  write('Vidéos 日本', 'sub', 'a.mkv');
  write('Vidéos 日本', 'sub', 'deeper', 'b.webm');
  write('Vidéos 日本', 'Été', 'c.mov');
  write('Photos', 'photo.jpg');

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('walks folders depth-first, files before subfolders, in natural order, skipping hidden entries', async () => {
    const { files, ignored, truncated } = await expandPaths([library], VIDEOS);
    expect(files).toEqual([
      at('Vidéos 日本', 'clip 2.mp4'),
      at('Vidéos 日本', 'clip 10.MP4'),
      at('Vidéos 日本', 'Été', 'c.mov'),
      at('Vidéos 日本', 'sub', 'a.mkv'),
      at('Vidéos 日本', 'sub', 'deeper', 'b.webm'),
    ]);
    // Other files in a folder are not "ignored": the folder was given for its videos.
    expect(ignored).toBe(0);
    expect(truncated).toBe(false);
  });

  it('keeps given files of an accepted type, hidden ones too, and counts the rest as ignored', async () => {
    const { files, ignored } = await expandPaths(
      [
        at('Vidéos 日本', '.hidden.mp4'),
        at('Vidéos 日本', 'notes.txt'),
        at('Vidéos 日本', 'gone.mp4'),
        'relative.mp4',
        '',
        at('Photos'),
      ],
      VIDEOS,
    );
    expect(files).toEqual([at('Vidéos 日本', '.hidden.mp4')]);
    expect(ignored).toBe(5);
  });

  it('lists each file once, even when a folder is given along with its parent', async () => {
    const clip = at('Vidéos 日本', 'clip 2.mp4');
    const { files, ignored } = await expandPaths(
      [clip, at('Vidéos 日本', 'sub'), library, clip],
      VIDEOS,
    );
    expect(files).toHaveLength(5);
    expect(new Set(files).size).toBe(5);
    expect(files.slice(0, 3)).toEqual([
      clip,
      at('Vidéos 日本', 'sub', 'a.mkv'),
      at('Vidéos 日本', 'sub', 'deeper', 'b.webm'),
    ]);
    expect(ignored).toBe(0);
  });

  it('ignores folders when they are not accepted', async () => {
    const { files, ignored } = await expandPaths([library], { ...VIDEOS, folders: false });
    expect(files).toEqual([]);
    expect(ignored).toBe(1);
  });

  it('stops at the limit, and says so', async () => {
    const { files, ignored, truncated } = await expandPaths([library, at('Photos')], {
      ...VIDEOS,
      limit: 3,
    });
    expect(files).toEqual([
      at('Vidéos 日本', 'clip 2.mp4'),
      at('Vidéos 日本', 'clip 10.MP4'),
      at('Vidéos 日本', 'Été', 'c.mov'),
    ]);
    expect(truncated).toBe(true);
    // Folders after the limit are left out, not ignored.
    expect(ignored).toBe(0);
  });

  it('does not follow links to folders, so a loop ends', async () => {
    const looping = at('Looping');
    write('Looping', 'clip.mp4');
    // A junction on Windows (no privilege needed), a symbolic link elsewhere.
    symlinkSync(looping, at('Looping', 'back'), 'junction');
    symlinkSync(library, at('Looping', 'library'), 'junction');

    const { files } = await expandPaths([looping], VIDEOS);
    expect(files).toEqual([at('Looping', 'clip.mp4')]);
  });
});
