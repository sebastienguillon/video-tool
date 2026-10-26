import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { outputName, partialName, publishOutput, removeFile } from './output-files';

describe('outputName and partialName', () => {
  it('appends the labels, then a number for copies', () => {
    expect(outputName('clip', ['no audio'], 'mp4', 1)).toBe('clip (no audio).mp4');
    expect(outputName('clip', ['no audio', 'trimmed'], 'mp4', 1)).toBe(
      'clip (no audio, trimmed).mp4',
    );
    expect(outputName('clip', ['no audio'], 'mp4', 2)).toBe('clip (no audio) 2.mp4');
    expect(outputName('Été 日本', ['trimmed'], 'mkv', 3)).toBe('Été 日本 (trimmed) 3.mkv');
  });

  it('hides partial files and keeps their extension', () => {
    expect(partialName('clip', 'webm', 'ab12cd34')).toBe('.clip.partial-ab12cd34.webm');
  });

  it('shortens long names to what file systems accept, by whole characters', () => {
    const name = outputName('日本'.repeat(100), ['no audio', 'trimmed'], 'mp4', 12);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
    expect(
      name.endsWith('日本 (no audio, trimmed) 12.mp4') ||
        name.endsWith('日 (no audio, trimmed) 12.mp4'),
    ).toBe(true);
    expect(name).not.toContain('�');
    const partial = partialName('é'.repeat(200), 'mp4', 'ab12cd34');
    expect(Buffer.byteLength(partial)).toBeLessThanOrEqual(255);
    expect(partial.endsWith('é.partial-ab12cd34.mp4')).toBe(true);
  });
});

describe('publishOutput', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'video-tool-output-é-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const nameFor = (copy: number) => outputName('clip', ['no audio'], 'mp4', copy);

  it('gives the partial file its final name', async () => {
    const partial = path.join(dir, partialName('clip', 'mp4', 'aaaa1111'));
    await writeFile(partial, 'result');
    const output = await publishOutput(partial, dir, nameFor);
    expect(output).toBe(path.join(dir, 'clip (no audio).mp4'));
    expect(await readFile(output, 'utf8')).toBe('result');
    expect(await readdir(dir)).toEqual(['clip (no audio).mp4']);
  });

  it('never replaces an existing file, numbering the copies', async () => {
    await writeFile(path.join(dir, 'clip (no audio).mp4'), 'first');
    await writeFile(path.join(dir, 'clip (no audio) 2.mp4'), 'second');
    const partial = path.join(dir, partialName('clip', 'mp4', 'bbbb2222'));
    await writeFile(partial, 'third');
    const output = await publishOutput(partial, dir, nameFor);
    expect(path.basename(output)).toBe('clip (no audio) 3.mp4');
    expect(await readFile(path.join(dir, 'clip (no audio).mp4'), 'utf8')).toBe('first');
    expect(await readFile(path.join(dir, 'clip (no audio) 2.mp4'), 'utf8')).toBe('second');
    expect(await readFile(output, 'utf8')).toBe('third');
  });

  it.skipIf(process.platform !== 'win32' && process.platform !== 'darwin')(
    'treats names differing in case as taken where the file system does',
    async () => {
      await writeFile(path.join(dir, 'CLIP (NO AUDIO).mp4'), 'first');
      const partial = path.join(dir, partialName('clip', 'mp4', 'cccc3333'));
      await writeFile(partial, 'second');
      expect(path.basename(await publishOutput(partial, dir, nameFor))).toBe(
        'clip (no audio) 2.mp4',
      );
      expect(await readFile(path.join(dir, 'CLIP (NO AUDIO).mp4'), 'utf8')).toBe('first');
    },
  );
});

describe('removeFile', () => {
  it('deletes a file, and accepts one already gone', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'video-tool-remove-'));
    const file = path.join(dir, 'partial.mp4');
    await writeFile(file, 'x');
    await removeFile(file);
    await removeFile(file);
    expect(await readdir(dir)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});
