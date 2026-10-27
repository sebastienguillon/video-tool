import type {
  AddResult,
  AudioTrack,
  Environment,
  Preset,
  PresetDraft,
  QueueItem,
  Recipe,
  Settings,
} from './model';

/** Which file of a video-list item to open or reveal. */
export type ItemFile = 'source' | 'output';

/** Which items `clearItems` removes. `finished`: done, failed, canceled and unsupported ones. */
export type ClearScope = 'all' | 'finished';

/**
 * API the preload script exposes to the renderer as `window.videoTool`. The main process owns the
 * video list, the audio list, the presets and the settings; the renderer shows them and asks for
 * changes.
 */
export interface DesktopBridge {
  readonly platform: string;
  /** Path of a `File` from a drop or a file input; `''` when it is not a local file. */
  readonly pathForFile: (file: File) => string;
  readonly getEnvironment: () => Promise<Environment>;

  // Video list.
  readonly listItems: () => Promise<readonly QueueItem[]>;
  /**
   * Adds videos by path. Folders add the videos they contain, subfolders included. Each new item
   * starts as `probing`, and changes arrive through `onItemsChanged`.
   */
  readonly addVideos: (paths: readonly string[]) => Promise<AddResult>;
  /** Asks for videos in an open dialog, then adds them; `null` if canceled. */
  readonly chooseVideos: () => Promise<AddResult | null>;
  /** Removes items; one being processed is canceled first. */
  readonly removeItems: (ids: readonly string[]) => Promise<void>;
  readonly clearItems: (scope: ClearScope) => Promise<void>;
  /** Puts done, failed or canceled items back to `ready`, to process them again. */
  readonly resetItems: (ids: readonly string[]) => Promise<void>;
  /**
   * Queues every item in a `PROCESSABLE_STATES` state with `recipe`, one video at a time;
   * resolves to how many were queued. An item the recipe cannot apply to ends `failed`, saying why.
   */
  readonly startProcessing: (recipe: Recipe) => Promise<number>;
  /** Cancels the given queued or running items, or all of them (`null`); partial files are deleted. */
  readonly cancelProcessing: (ids: readonly string[] | null) => Promise<void>;
  /** Opens a file with the system's default app. */
  readonly openItem: (id: string, file: ItemFile) => Promise<void>;
  /** Shows a file in Finder / Explorer / the file manager. */
  readonly revealItem: (id: string, file: ItemFile) => Promise<void>;
  /** Called with the whole list after every change (progress included, at most a few times a second). */
  readonly onItemsChanged: (listener: (items: readonly QueueItem[]) => void) => () => void;

  // Audio list, persisted.
  readonly listTracks: () => Promise<readonly AudioTrack[]>;
  /** Adds audio files by path (no folders); new ones are probed for their duration. */
  readonly addTracks: (paths: readonly string[]) => Promise<AddResult>;
  /** Asks for audio files in an open dialog, then adds them; `null` if canceled. */
  readonly chooseTracks: () => Promise<AddResult | null>;
  /** Forgets a track; the file itself is untouched. */
  readonly removeTrack: (id: string) => Promise<void>;
  /**
   * Sets what the names of results say of a track (`AudioTrack.suffix`), cleaned up by
   * `trackSuffix`: what file names cannot hold becomes a space, and nothing left means the file's
   * name. Resolves to the suffix kept; `null` when the track is no longer listed.
   */
  readonly setTrackSuffix: (id: string, suffix: string) => Promise<string | null>;
  readonly onTracksChanged: (listener: (tracks: readonly AudioTrack[]) => void) => () => void;

  // Presets, persisted.
  readonly listPresets: () => Promise<readonly Preset[]>;
  /**
   * Saves a new preset, or a new version of the one with the draft's id; resolves to the preset as
   * saved, its name cleaned up (see `presetName`). Rejects, saying why, a preset that `presetIssue`
   * refuses, or the new version of one that was deleted.
   */
  readonly savePreset: (draft: PresetDraft) => Promise<Preset>;
  /** Forgets a preset; the settings no longer name it as the one applied last. */
  readonly removePreset: (id: string) => Promise<void>;
  readonly onPresetsChanged: (listener: (presets: readonly Preset[]) => void) => () => void;

  // Settings, persisted.
  readonly getSettings: () => Promise<Settings>;
  readonly updateSettings: (patch: Partial<Settings>) => Promise<Settings>;
  /** Asks for the output folder in a dialog; `null` if canceled. Does not change the settings. */
  readonly chooseOutputFolder: () => Promise<string | null>;
}

/** `invoke` channels (renderer → main) and `send` channels (main → renderer). */
export const IpcChannel = {
  getEnvironment: 'app:environment',
  listItems: 'items:list',
  addVideos: 'items:add',
  chooseVideos: 'items:choose',
  removeItems: 'items:remove',
  clearItems: 'items:clear',
  resetItems: 'items:reset',
  startProcessing: 'items:start',
  cancelProcessing: 'items:cancel',
  openItem: 'items:open',
  revealItem: 'items:reveal',
  itemsChanged: 'items:changed',
  listTracks: 'tracks:list',
  addTracks: 'tracks:add',
  chooseTracks: 'tracks:choose',
  removeTrack: 'tracks:remove',
  setTrackSuffix: 'tracks:set-suffix',
  tracksChanged: 'tracks:changed',
  listPresets: 'presets:list',
  savePreset: 'presets:save',
  removePreset: 'presets:remove',
  presetsChanged: 'presets:changed',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  chooseOutputFolder: 'settings:choose-output-folder',
} as const;

/** `thumb://video/<item id>`: a still from a video of the list (JPEG). */
export const THUMBNAIL_SCHEME = 'thumb';
/** `track://audio/<track id>`: an audio file of the audio list, streamed for previews. */
export const TRACK_SCHEME = 'track';

export function thumbnailUrl(itemId: string): string {
  return `${THUMBNAIL_SCHEME}://video/${encodeURIComponent(itemId)}`;
}

export function trackUrl(trackId: string): string {
  return `${TRACK_SCHEME}://audio/${encodeURIComponent(trackId)}`;
}
