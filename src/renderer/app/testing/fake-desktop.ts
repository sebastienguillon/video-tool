import type { DesktopBridge } from '@shared/desktop-api';
import type {
  AddResult,
  AudioTrack,
  Environment,
  QueueItem,
  Settings,
  VideoInfo,
} from '@shared/model';
import { DEFAULT_SETTINGS } from '@shared/model';

/** The bridge's methods. */
type Method = {
  [K in keyof DesktopBridge]: DesktopBridge[K] extends (...args: never[]) => unknown ? K : never;
}[keyof DesktopBridge];

type Listener<T> = (value: T) => void;

export const NOTHING_ADDED: AddResult = { added: 0, duplicates: 0, ignored: 0, truncated: false };

export const environment: Environment = {
  appVersion: '2026.10.0-alpha.1',
  ffmpeg: { path: 'C:\\ffmpeg\\bin\\ffmpeg.exe', version: '7.1', supported: true },
  dataDir: 'C:\\Users\\Sébastien\\AppData\\Roaming\\Video Tool',
};

export const info: VideoInfo = {
  durationSec: 65.4,
  width: 1920,
  height: 1080,
  frameRate: 29.97,
  frameCount: 1960,
  videoCodec: 'h264',
  audioCodec: 'aac',
  container: 'mp4',
  sizeBytes: 12_340_000,
};

/** A video of the list, `ready` unless told otherwise. */
export function queueItem(id: string, overrides: Partial<QueueItem> = {}): QueueItem {
  const name = `${id}.mp4`;
  return {
    id,
    path: `D:\\Vidéos\\été 日本\\${name}`,
    name,
    folder: 'D:\\Vidéos\\été 日本',
    info,
    state: { kind: 'ready' },
    ...overrides,
  };
}

export function audioTrack(id: string, overrides: Partial<AudioTrack> = {}): AudioTrack {
  const name = `${id}.mp3`;
  return {
    id,
    path: `C:\\Music\\${name}`,
    name,
    durationSec: 95,
    status: 'ok',
    ...overrides,
  };
}

/**
 * Stands in for `window.videoTool`: records calls, answers from its fields unless a test scripts
 * an answer with `respond`, and sends list changes on demand like the main process.
 */
export class FakeDesktop implements DesktopBridge {
  platform = 'win32';
  items: readonly QueueItem[] = [];
  tracks: readonly AudioTrack[] = [];
  settings: Settings = DEFAULT_SETTINGS;
  readonly calls: { readonly method: Method; readonly args: readonly unknown[] }[] = [];
  private readonly responders = new Map<Method, (...args: never[]) => unknown>();
  private readonly itemListeners = new Set<Listener<readonly QueueItem[]>>();
  private readonly trackListeners = new Set<Listener<readonly AudioTrack[]>>();

  readonly pathForFile = (file: File): string =>
    this.call('pathForFile', [file], () => `D:\\Vidéos\\${file.name}`);
  readonly getEnvironment = (): Promise<Environment> =>
    this.call('getEnvironment', [], () => Promise.resolve(environment));
  readonly listItems = (): Promise<readonly QueueItem[]> =>
    this.call('listItems', [], () => Promise.resolve(this.items));
  readonly addVideos = (paths: readonly string[]): Promise<AddResult> =>
    this.call('addVideos', [paths], () => Promise.resolve(NOTHING_ADDED));
  readonly chooseVideos = (): Promise<AddResult | null> =>
    this.call('chooseVideos', [], () => Promise.resolve(null));
  readonly removeItems = (ids: readonly string[]): Promise<void> =>
    this.call('removeItems', [ids], () => Promise.resolve());
  readonly clearItems = (scope: 'all' | 'finished'): Promise<void> =>
    this.call('clearItems', [scope], () => Promise.resolve());
  readonly resetItems = (ids: readonly string[]): Promise<void> =>
    this.call('resetItems', [ids], () => Promise.resolve());
  readonly startProcessing = (recipe: Settings['recipe']): Promise<number> =>
    this.call('startProcessing', [recipe], () => Promise.resolve(0));
  readonly cancelProcessing = (ids: readonly string[] | null): Promise<void> =>
    this.call('cancelProcessing', [ids], () => Promise.resolve());
  readonly openItem = (id: string, file: 'source' | 'output'): Promise<void> =>
    this.call('openItem', [id, file], () => Promise.resolve());
  readonly revealItem = (id: string, file: 'source' | 'output'): Promise<void> =>
    this.call('revealItem', [id, file], () => Promise.resolve());
  readonly listTracks = (): Promise<readonly AudioTrack[]> =>
    this.call('listTracks', [], () => Promise.resolve(this.tracks));
  readonly addTracks = (paths: readonly string[]): Promise<AddResult> =>
    this.call('addTracks', [paths], () => Promise.resolve(NOTHING_ADDED));
  readonly chooseTracks = (): Promise<AddResult | null> =>
    this.call('chooseTracks', [], () => Promise.resolve(null));
  readonly removeTrack = (id: string): Promise<void> =>
    this.call('removeTrack', [id], () => Promise.resolve());
  readonly getSettings = (): Promise<Settings> =>
    this.call('getSettings', [], () => Promise.resolve(this.settings));
  readonly updateSettings = (patch: Partial<Settings>): Promise<Settings> =>
    this.call('updateSettings', [patch], () => {
      this.settings = { ...this.settings, ...patch };
      return Promise.resolve(this.settings);
    });
  readonly chooseOutputFolder = (): Promise<string | null> =>
    this.call('chooseOutputFolder', [], () => Promise.resolve(null));

  readonly onItemsChanged = (listener: Listener<readonly QueueItem[]>): (() => void) => {
    this.itemListeners.add(listener);
    return () => this.itemListeners.delete(listener);
  };

  readonly onTracksChanged = (listener: Listener<readonly AudioTrack[]>): (() => void) => {
    this.trackListeners.add(listener);
    return () => this.trackListeners.delete(listener);
  };

  /** Answers calls to `method` with `responder` from now on. */
  respond<K extends Method>(method: K, responder: DesktopBridge[K]): void {
    this.responders.set(method, responder);
  }

  callsTo(method: Method): readonly (readonly unknown[])[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  /** As the main process does after every change to the video list. */
  emitItems(items: readonly QueueItem[]): void {
    this.items = items;
    this.itemListeners.forEach((listener) => {
      listener(items);
    });
  }

  emitTracks(tracks: readonly AudioTrack[]): void {
    this.tracks = tracks;
    this.trackListeners.forEach((listener) => {
      listener(tracks);
    });
  }

  private call<R>(method: Method, args: readonly unknown[], fallback: () => R): R {
    this.calls.push({ method, args });
    const responder = this.responders.get(method) as ((...a: readonly unknown[]) => R) | undefined;
    return responder ? responder(...args) : fallback();
  }
}

/** Lets pending promise callbacks run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

/** Text content, with white space collapsed. */
export function text(element: Element | null | undefined): string {
  return element?.textContent.replace(/\s+/g, ' ').trim() ?? '';
}
