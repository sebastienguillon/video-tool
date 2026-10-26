import { THUMBNAIL_SCHEME, TRACK_SCHEME } from '@shared/desktop-api';
import { createLogger } from '@shared/log';
import { net, protocol } from 'electron';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AudioLibrary } from './audio-library';
import { fileResponse } from './file-response';
import type { Queue } from './queue';
import { extensionOf } from './video-files';

const log = createLogger('protocols');

/** Origin the production renderer is served from. */
export const APP_ORIGIN = 'app://bundle';
/** Hosts of the `thumbnailUrl()` and `trackUrl()` URLs. */
export const THUMBNAIL_HOST = 'video';
export const TRACK_HOST = 'audio';

/**
 * Content Security Policy of the renderer. Component styles are injected at runtime, hence
 * `'unsafe-inline'` for styles only. Thumbnails come from the `thumb:` scheme, previews of the
 * audio list from `track:`.
 */
export function contentSecurityPolicy(devServer: string | null): string {
  const connect = devServer === null ? "'self'" : `'self' ${devServer.replace(/^http/, 'ws')}`;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' ${THUMBNAIL_SCHEME}: data:`,
    `media-src ${TRACK_SCHEME}:`,
    "font-src 'self'",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Must run before the app is ready. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
    },
    { scheme: THUMBNAIL_SCHEME, privileges: { standard: true, secure: true } },
    // `stream` lets a preview start before the whole file is read, and seek with byte ranges.
    { scheme: TRACK_SCHEME, privileges: { standard: true, secure: true, stream: true } },
  ]);
}

/** A JPEG still of a video; rejects when there is none. */
export type RenderThumbnail = (file: string, durationSec: number | null) => Promise<Uint8Array>;

export interface ProtocolServices {
  /** The built Angular app (`dist/renderer/browser`). */
  readonly rendererRoot: string;
  readonly queue: Pick<Queue, 'list'>;
  readonly library: Pick<AudioLibrary, 'resolve'>;
  /** `null` without ffmpeg: no thumbnails. */
  readonly renderThumbnail: RenderThumbnail | null;
}

export function handleProtocols({
  rendererRoot,
  queue,
  library,
  renderThumbnail,
}: ProtocolServices): void {
  const thumbnails = renderThumbnail === null ? null : new ThumbnailCache(renderThumbnail);
  protocol.handle('app', (request) => serveApp(request, rendererRoot));
  protocol.handle(THUMBNAIL_SCHEME, (request) => serveThumbnail(request, queue, thumbnails));
  protocol.handle(TRACK_SCHEME, (request) => serveTrack(request, library));
}

/**
 * The file below `root` that an `app://bundle/…` URL names; `null` for another host, or a path
 * that would escape `root`.
 */
export function appFile(url: string, root: string): string | null {
  const parsed = URL.parse(url);
  if (parsed?.host.toLowerCase() !== 'bundle') {
    return null;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  const file = path.join(root, path.normalize(pathname).replace(/^[/\\]+/, ''));
  return file === root || file.startsWith(root + path.sep) ? file : null;
}

/** Serves the built Angular app, falling back to `index.html` for client-side routes. */
async function serveApp(request: Request, root: string): Promise<Response> {
  const file = appFile(request.url, root);
  if (file === null) {
    return new Response('Forbidden', { status: 403 });
  }
  const target = file !== root && (await isFile(file)) ? file : path.join(root, 'index.html');
  const response = await net.fetch(pathToFileURL(target).toString());
  if (!target.endsWith('.html')) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', contentSecurityPolicy(null));
  return new Response(response.body, { status: response.status, headers });
}

/**
 * The id of a `<scheme>://<host>/<id>` URL, decoded; `null` when the URL has another shape. The
 * id is only ever looked up, never used as a path.
 */
export function resourceId(url: string, scheme: string, host: string): string | null {
  const parsed = URL.parse(url);
  if (parsed?.protocol !== `${scheme}:` || parsed.host.toLowerCase() !== host) {
    return null;
  }
  const segment = parsed.pathname.slice(1);
  if (segment === '' || segment.includes('/')) {
    return null;
  }
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

const NOT_FOUND = (): Response =>
  new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });

/** `thumb://video/<item id>`: a still of a video of the list, never of any other file. */
async function serveThumbnail(
  request: Request,
  queue: Pick<Queue, 'list'>,
  thumbnails: ThumbnailCache | null,
): Promise<Response> {
  const id = resourceId(request.url, THUMBNAIL_SCHEME, THUMBNAIL_HOST);
  const item = id === null ? undefined : queue.list().find((entry) => entry.id === id);
  if (thumbnails === null || item === undefined || item.state.kind === 'unsupported') {
    return NOT_FOUND();
  }
  const durationSec = item.info?.durationSec ?? null;
  const jpeg = await thumbnails.get(item.id, item.path, durationSec);
  return jpeg === null
    ? NOT_FOUND()
    : new Response(jpeg, {
        headers: {
          'Content-Type': 'image/jpeg',
          // An item keeps its id and file for as long as it is listed. A still taken before the
          // duration was known (near the start, while probing) is worth asking for again.
          'Cache-Control':
            durationSec === null ? 'private, no-cache' : 'private, max-age=31536000, immutable',
        },
      });
}

const AUDIO_TYPES: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  wma: 'audio/x-ms-wma',
};

export function audioContentType(file: string): string {
  return AUDIO_TYPES[extensionOf(file)] ?? 'application/octet-stream';
}

/** `track://audio/<track id>`: a file of the audio list, never any other file. */
function serveTrack(request: Request, library: Pick<AudioLibrary, 'resolve'>): Promise<Response> {
  const id = resourceId(request.url, TRACK_SCHEME, TRACK_HOST);
  const file = id === null ? null : library.resolve(id);
  return file === null
    ? Promise.resolve(NOT_FOUND())
    : fileResponse(file, request.headers.get('Range'), audioContentType(file));
}

/** Rough memory cost of an entry besides its bytes, so that cached failures count too. */
const ENTRY_OVERHEAD = 256;

/**
 * Thumbnails rendered on demand: a few ffmpeg runs at a time, one per video however many times it
 * is asked for, and the latest results kept in memory (failures too, as asking again would fail
 * again), least recently used dropped first beyond `maxBytes`.
 */
export class ThumbnailCache {
  private readonly render: RenderThumbnail;
  private readonly maxBytes: number;
  private readonly limit: <T>(task: () => Promise<T>) => Promise<T>;
  /** Least recently used first. */
  private readonly entries = new Map<string, Uint8Array | null>();
  private readonly pending = new Map<string, Promise<Uint8Array | null>>();
  private bytes = 0;

  constructor(render: RenderThumbnail, { maxBytes = 32 * 1024 * 1024, concurrency = 2 } = {}) {
    this.render = render;
    this.maxBytes = maxBytes;
    this.limit = createLimiter(concurrency);
  }

  /** The still of item `id`; `null` when it cannot be rendered. */
  get(id: string, file: string, durationSec: number | null): Promise<Uint8Array | null> {
    // Once the duration is known, a better still can be taken than the one rendered before.
    const key = `${id}\n${file}\n${durationSec ?? ''}`;
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return Promise.resolve(cached);
    }
    let pending = this.pending.get(key);
    if (pending === undefined) {
      pending = this.limit(() => this.render(file, durationSec))
        .catch((error: unknown) => {
          log.warn(`No thumbnail for ${file}:`, error instanceof Error ? error.message : error);
          return null;
        })
        .then((jpeg) => {
          this.pending.delete(key);
          this.store(key, jpeg);
          return jpeg;
        });
      this.pending.set(key, pending);
    }
    return pending;
  }

  private store(key: string, jpeg: Uint8Array | null): void {
    if (sizeOf(jpeg) > this.maxBytes) {
      return;
    }
    this.entries.set(key, jpeg);
    this.bytes += sizeOf(jpeg);
    for (const [oldest, value] of this.entries) {
      if (this.bytes <= this.maxBytes) {
        break;
      }
      this.entries.delete(oldest);
      this.bytes -= sizeOf(value);
    }
  }
}

function sizeOf(jpeg: Uint8Array | null): number {
  return ENTRY_OVERHEAD + (jpeg?.byteLength ?? 0);
}

/** Returns a function that runs at most `concurrency` tasks at once, the others waiting in order. */
function createLimiter(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  // A finishing task hands its slot straight to the next waiter, so newcomers cannot overtake it.
  const release = (): void => {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      active--;
    }
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < concurrency) {
      active++;
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      release();
    }
  };
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
