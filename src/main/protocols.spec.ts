import { THUMBNAIL_SCHEME, thumbnailUrl, TRACK_SCHEME, trackUrl } from '@shared/desktop-api';
import { AUDIO_EXTENSIONS } from '@shared/model';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  appFile,
  audioContentType,
  contentSecurityPolicy,
  resourceId,
  THUMBNAIL_HOST,
  ThumbnailCache,
  TRACK_HOST,
} from './protocols';

vi.mock('electron', () => ({ net: {}, protocol: {} }));

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

describe('contentSecurityPolicy', () => {
  it('allows thumbnails and audio previews from their schemes only', () => {
    const policy = contentSecurityPolicy(null).split('; ');
    expect(policy).toContain("img-src 'self' thumb: data:");
    expect(policy).toContain('media-src track:');
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("object-src 'none'");
  });

  it('lets the dev server push reloads through its WebSocket', () => {
    expect(contentSecurityPolicy('http://localhost:4318').split('; ')).toContain(
      "connect-src 'self' ws://localhost:4318",
    );
  });
});

describe('resourceId', () => {
  it('reads back the ids of thumbnailUrl() and trackUrl(), whatever their characters', () => {
    for (const id of ['42', 'b9f1-4c', 'a/b', 'é 日本', '100%', '?#']) {
      expect(resourceId(thumbnailUrl(id), THUMBNAIL_SCHEME, THUMBNAIL_HOST)).toBe(id);
      expect(resourceId(trackUrl(id), TRACK_SCHEME, TRACK_HOST)).toBe(id);
    }
  });

  it('refuses URLs of another shape', () => {
    expect(resourceId(trackUrl('42'), THUMBNAIL_SCHEME, THUMBNAIL_HOST)).toBeNull();
    expect(resourceId('thumb://audio/42', THUMBNAIL_SCHEME, THUMBNAIL_HOST)).toBeNull();
    expect(resourceId('thumb://video/', THUMBNAIL_SCHEME, THUMBNAIL_HOST)).toBeNull();
    expect(resourceId('thumb://video/a/b', THUMBNAIL_SCHEME, THUMBNAIL_HOST)).toBeNull();
    expect(resourceId('thumb://video/%E0%A4%A', THUMBNAIL_SCHEME, THUMBNAIL_HOST)).toBeNull();
    expect(resourceId('not a url', THUMBNAIL_SCHEME, THUMBNAIL_HOST)).toBeNull();
  });

  it('accepts the host in any case, as Chromium may lowercase it or not', () => {
    expect(resourceId('thumb://VIDEO/42', THUMBNAIL_SCHEME, THUMBNAIL_HOST)).toBe('42');
  });
});

describe('appFile', () => {
  const root = path.resolve('/app/dist/renderer/browser');

  it('maps app URLs to the files of the bundle', () => {
    expect(appFile('app://bundle/main-ABC.js', root)).toBe(path.join(root, 'main-ABC.js'));
    expect(appFile('app://bundle/media/Inter%20Variable.woff2', root)).toBe(
      path.join(root, 'media', 'Inter Variable.woff2'),
    );
    expect(appFile('app://bundle/', root)).toBe(root);
  });

  it('never leaves the bundle', () => {
    for (const url of [
      'app://bundle/../../secret.txt',
      'app://bundle/%2e%2e/%2e%2e/secret.txt',
      'app://bundle/..%2F..%2Fsecret.txt',
      'app://bundle/..%5C..%5Csecret.txt',
      'app://bundle/C:/Windows/win.ini',
    ]) {
      const file = appFile(url, root);
      expect(file === root || file?.startsWith(root + path.sep), url).toBe(true);
    }
    expect(appFile('app://other/main.js', root)).toBeNull();
    expect(appFile('app://bundle/%E0%A4%A', root)).toBeNull();
  });
});

describe('audioContentType', () => {
  it('knows every accepted audio extension, in any case', () => {
    for (const extension of AUDIO_EXTENSIONS) {
      expect(audioContentType(`song.${extension.toUpperCase()}`)).toMatch(/^audio\//);
    }
    expect(audioContentType('song.mp3')).toBe('audio/mpeg');
    expect(audioContentType('song.m4a')).toBe('audio/mp4');
    expect(audioContentType('song.opus')).toBe('audio/ogg');
    expect(audioContentType('song.bin')).toBe('application/octet-stream');
  });
});

describe('ThumbnailCache', () => {
  const jpeg = (size: number): Uint8Array => new Uint8Array(size);

  it('renders a thumbnail once, however many times and however soon it is asked for', async () => {
    const render = vi.fn(async () => {
      await tick();
      return jpeg(10);
    });
    const cache = new ThumbnailCache(render);
    const [first, second] = await Promise.all([
      cache.get('1', 'clip.mp4', 12),
      cache.get('1', 'clip.mp4', 12),
    ]);
    expect(await cache.get('1', 'clip.mp4', 12)).toBe(first);
    expect(second).toBe(first);
    expect(render).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledWith('clip.mp4', 12);
  });

  it('renders again once the duration is known', async () => {
    const render = vi.fn(() => Promise.resolve(jpeg(10)));
    const cache = new ThumbnailCache(render);
    await cache.get('1', 'clip.mp4', null);
    await cache.get('1', 'clip.mp4', 12);
    expect(render.mock.calls).toEqual([
      ['clip.mp4', null],
      ['clip.mp4', 12],
    ]);
  });

  it('remembers failures, as asking again would fail again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const render = vi.fn(() => Promise.reject(new Error('Invalid data found')));
    const cache = new ThumbnailCache(render);
    expect(await cache.get('1', 'broken.mp4', 3)).toBeNull();
    expect(await cache.get('1', 'broken.mp4', 3)).toBeNull();
    expect(render).toHaveBeenCalledOnce();
  });

  it('renders at most two at a time', async () => {
    let running = 0;
    let peak = 0;
    const cache = new ThumbnailCache(async () => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
      return jpeg(10);
    });
    await Promise.all(Array.from({ length: 6 }, (_, id) => cache.get(String(id), `${id}.mp4`, 1)));
    expect(peak).toBe(2);
  });

  it('drops the least recently used thumbnails beyond its size', async () => {
    const render = vi.fn((file: string) => Promise.resolve(jpeg(file === 'big.mp4' ? 1000 : 300)));
    // Room for two small thumbnails (each counts for its bytes plus some overhead), not three.
    const cache = new ThumbnailCache(render, { maxBytes: 1200 });
    await cache.get('a', 'a.mp4', 1);
    await cache.get('b', 'b.mp4', 1);
    await cache.get('a', 'a.mp4', 1);
    await cache.get('c', 'c.mp4', 1);
    expect(render).toHaveBeenCalledTimes(3);
    // `b` was the least recently used.
    await cache.get('a', 'a.mp4', 1);
    expect(render).toHaveBeenCalledTimes(3);
    await cache.get('b', 'b.mp4', 1);
    expect(render).toHaveBeenCalledTimes(4);
    // Too big to keep at all.
    await cache.get('big', 'big.mp4', 1);
    await cache.get('big', 'big.mp4', 1);
    expect(render).toHaveBeenCalledTimes(6);
  });
});
