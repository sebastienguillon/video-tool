/** Domain model shared by the main process and the renderer. Plain data only: it crosses IPC. */

/** Extensions (lowercase, no dot) of the videos accepted from a drop, a dialog or a folder. */
export const VIDEO_EXTENSIONS: readonly string[] = [
  'mp4',
  'm4v',
  'mov',
  'qt',
  'mkv',
  'webm',
  'avi',
  'wmv',
  'flv',
  'mpg',
  'mpeg',
  'm2ts',
  'mts',
  'ts',
  '3gp',
  'ogv',
];

/** Extensions (lowercase, no dot) of the audio files accepted in the audio list. */
export const AUDIO_EXTENSIONS: readonly string[] = [
  'mp3',
  'm4a',
  'aac',
  'wav',
  'flac',
  'ogg',
  'oga',
  'opus',
  'aif',
  'aiff',
  'wma',
];

/** What ffprobe tells about a video, as the interface shows it and the recipe checks use it. */
export interface VideoInfo {
  /** Of the video stream, falling back to the container's. */
  readonly durationSec: number;
  /** As displayed, rotation applied. */
  readonly width: number;
  readonly height: number;
  /** Average frames per second; `null` when ffprobe cannot tell (then frame counts are refused). */
  readonly frameRate: number | null;
  /** Frames in the video stream, when the container records it (MP4, MOV); `null` otherwise. */
  readonly frameCount: number | null;
  /** ffprobe codec name of the video stream, e.g. `h264`, `hevc`, `vp9`. */
  readonly videoCodec: string;
  /** ffprobe codec name of the first audio stream; `null` for a silent video. */
  readonly audioCodec: string | null;
  /** File extension, lowercase, without the dot. */
  readonly container: string;
  readonly sizeBytes: number;
}

/** An entry of the persisted audio list, the replacement soundtracks to choose from. */
export interface AudioTrack {
  readonly id: string;
  readonly path: string;
  /** File name, with its extension. */
  readonly name: string;
  /**
   * What the name of a result says when this track replaced its audio: `clip (<suffix>).mp4`. The
   * file name without its extension, unless the user chose another.
   */
  readonly suffix: string;
  /** `null` until probed, or when the file is missing or unreadable. */
  readonly durationSec: number | null;
  readonly status: 'probing' | 'ok' | 'missing' | 'unreadable';
}

export type TrimUnit = 'seconds' | 'frames';

/**
 * A length at the start or the end of the video, to remove (a trim) or to silence: fractional
 * seconds, or a whole number of frames. `0` is none.
 */
export interface Trim {
  readonly amount: number;
  readonly unit: TrimUnit;
}

export type AudioMode = 'keep' | 'remove' | 'replace';

/**
 * `exact` re-encodes the video, so cuts land on the exact frame. `fast` copies it untouched, but a
 * cut at the start moves back to the previous keyframe.
 */
export type CutPrecision = 'exact' | 'fast';

/** The treatments applied to every video of a run, in one ffmpeg pass per video. */
export interface Recipe {
  readonly audio: AudioMode;
  /** The replacement soundtrack (an `AudioTrack.id`), used when `audio` is `replace`. */
  readonly trackId: string | null;
  /** Replacement audio shorter than the video starts over; otherwise silence fills the rest. */
  readonly loop: boolean;
  readonly trimStart: Trim;
  readonly trimEnd: Trim;
  /**
   * How long the audio, kept or new, is muted at the start and at the end of the result: counted
   * from its first frame and from the end of its last, once trimmed. Unused when `audio` is
   * `remove`.
   */
  readonly silenceStart: Trim;
  readonly silenceEnd: Trim;
  readonly precision: CutPrecision;
}

export const DEFAULT_RECIPE: Recipe = {
  audio: 'remove',
  trackId: null,
  loop: true,
  trimStart: { amount: 0, unit: 'seconds' },
  trimEnd: { amount: 0, unit: 'seconds' },
  silenceStart: { amount: 0, unit: 'seconds' },
  silenceEnd: { amount: 0, unit: 'seconds' },
  precision: 'exact',
};

/** `beside`: next to each source video. `folder`: all in `OutputSettings.folder`. */
export type OutputLocation = 'beside' | 'folder';

export interface OutputSettings {
  readonly location: OutputLocation;
  readonly folder: string | null;
}

/** Persisted in the data folder, restored on launch. */
export interface Settings {
  readonly recipe: Recipe;
  readonly output: OutputSettings;
  /** The preset applied last, which the treatments may have changed from since; `null`: none. */
  readonly presetId: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  recipe: DEFAULT_RECIPE,
  output: { location: 'beside', folder: null },
  presetId: null,
};

/**
 * The parts of the treatments a preset can set, as the panel shows them. Applying a preset changes
 * those it holds, and leaves the others as they are.
 */
export type PresetSection = 'audio' | 'silence' | 'trim' | 'output';

/** In the order of the panel. */
export const PRESET_SECTIONS: readonly PresetSection[] = ['audio', 'silence', 'trim', 'output'];

/** What a preset holds of the sections it sets; those it leaves alone are absent. */
export interface PresetValues {
  /** Keep, remove or replace the audio; the soundtrack and the loop are a replaced audio's. */
  readonly audio?: Pick<Recipe, 'audio' | 'trackId' | 'loop'>;
  readonly silence?: Pick<Recipe, 'silenceStart' | 'silenceEnd'>;
  /** The trims, and how precisely they cut. */
  readonly trim?: Pick<Recipe, 'trimStart' | 'trimEnd' | 'precision'>;
  /** Where the results go. */
  readonly output?: OutputSettings;
}

/** Treatments saved under a name, to apply them again in one go. Persisted in the data folder. */
export interface Preset extends PresetValues {
  readonly id: string;
  /** Unique, whatever the case (see `presetKey`). */
  readonly name: string;
}

/** A preset to save: a new one, without an id yet, or a new version of one. */
export type PresetDraft = PresetValues & { readonly id?: string; readonly name: string };

/** Where a video of the list stands. Only `running` changes often (progress). */
export type ItemState =
  | { readonly kind: 'probing' }
  /** Probed: can be processed. */
  | { readonly kind: 'ready' }
  /** Not a video ffprobe can read; never processed. */
  | { readonly kind: 'unsupported'; readonly message: string }
  | { readonly kind: 'queued' }
  | {
      readonly kind: 'running';
      /** 0 to 1; `null` until ffmpeg reports. */
      readonly progress: number | null;
      /** Times real time, e.g. `2.5`; `null` until ffmpeg reports. */
      readonly speed: number | null;
    }
  | { readonly kind: 'done'; readonly outputPath: string }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'canceled' };

export type ItemStateKind = ItemState['kind'];

/** A video of the list. Its source file is only ever read. */
export interface QueueItem {
  readonly id: string;
  readonly path: string;
  /** File name, with its extension. */
  readonly name: string;
  /** The folder that contains it. */
  readonly folder: string;
  /** `null` until probed, or when unsupported. */
  readonly info: VideoInfo | null;
  readonly state: ItemState;
}

/** States a run picks up: `startProcessing` queues these. */
export const PROCESSABLE_STATES: readonly ItemStateKind[] = ['ready', 'failed', 'canceled'];

/**
 * Most files taken from folders by one drop or dialog, all folders together: a drive dropped by
 * mistake adds a long but workable list instead of freezing the app. `AddResult.truncated` says
 * when it was reached.
 */
export const FOLDER_FILE_LIMIT = 5_000;

/** Outcome of adding files to the video list or the audio list. */
export interface AddResult {
  readonly added: number;
  /** Already in the list: not added twice. */
  readonly duplicates: number;
  /** Not of an accepted type (by extension), or not found. */
  readonly ignored: number;
  /** Folders held more files than one drop takes (`FOLDER_FILE_LIMIT`): the rest were left out. */
  readonly truncated: boolean;
}

export interface Environment {
  readonly appVersion: string;
  /** `null` when ffmpeg or ffprobe cannot be found: nothing can be processed. */
  readonly ffmpeg: {
    readonly path: string;
    /** As ffmpeg reports it, e.g. `7.1-full_build-www.gyan.dev`. */
    readonly version: string;
    /** `false` when it lacks options the treatments need: nothing can be processed either. */
    readonly supported: boolean;
  } | null;
  /** The data folder, which holds the settings and the audio list. */
  readonly dataDir: string;
}

/**
 * The oldest ffmpeg Video Tool is tested with, as Ubuntu 22.04 ships it. Older ones are refused
 * only when they lack an option it needs, which ffmpeg 3.3 and older do.
 */
export const MIN_FFMPEG_VERSION = '4.4';
