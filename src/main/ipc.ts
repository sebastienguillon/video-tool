import type { ClearScope, DesktopBridge, ItemFile } from '@shared/desktop-api';
import { IpcChannel } from '@shared/desktop-api';
import type {
  AddResult,
  AudioTrack,
  Environment,
  OutputSettings,
  QueueItem,
  Recipe,
  Settings,
  Trim,
} from '@shared/model';
import { AUDIO_EXTENSIONS, MIN_FFMPEG_VERSION, VIDEO_EXTENSIONS } from '@shared/model';
import { recipeIssue } from '@shared/recipe';
import type { FileFilter, IpcMainInvokeEvent, OpenDialogOptions } from 'electron';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { AudioLibrary } from './audio-library';
import type { MediaTools } from './media/media-tools';
import { isSupported } from './media/media-tools';
import type { Queue } from './queue';
import type { SettingsStore } from './settings-store';
import {
  isAudioMode,
  isCutPrecision,
  isOutputLocation,
  isRecord,
  isTrimUnit,
} from './settings-store';
import { expandPaths } from './video-files';
import { originOf } from './window';

/** Bridge methods the main process answers: all but `platform`, `pathForFile` and subscriptions. */
type InvokeMethod = keyof DesktopBridge & keyof typeof IpcChannel;
type Result<K extends InvokeMethod> = Awaited<ReturnType<DesktopBridge[K]>>;

/** More paths or ids than any drop or selection makes: a renderer bug, not a request. */
const MAX_LIST_LENGTH = 100_000;
const MAX_ID_LENGTH = 256;

const ALL_FILES: FileFilter = { name: 'All files', extensions: ['*'] };

export interface IpcServices {
  readonly queue: Queue;
  readonly library: AudioLibrary;
  readonly store: SettingsStore;
  readonly tools: MediaTools | null;
  /** Origin of the renderer, as `originOf` gives it: no other page may call the main process. */
  readonly trustedOrigin: string;
  readonly dataDir: string;
}

/**
 * Answers every `DesktopBridge` call. Arguments come from the renderer and are checked before use:
 * wrong types are rejected, with messages meant for developers, as only a bug can send them.
 */
export function registerIpc({
  queue,
  library,
  store,
  tools,
  trustedOrigin,
  dataDir,
}: IpcServices): void {
  const handle = <K extends InvokeMethod>(
    method: K,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Result<K> | Promise<Result<K>>,
  ): void => {
    ipcMain.handle(IpcChannel[method], (event, ...args: unknown[]) => {
      const url = event.senderFrame?.url;
      if (url === undefined || originOf(url) !== trustedOrigin) {
        throw new Error(`Refused ${method} from ${url ?? 'a closed frame'}.`);
      }
      return handler(event, ...args);
    });
  };

  // Where the open dialogs start, remembered for this session only.
  let videoFolder: string | undefined;
  let trackFolder: string | undefined;

  handle('getEnvironment', () => environmentOf(tools, app.getVersion(), dataDir));

  handle('listItems', () => queue.list());

  handle('addVideos', (_event, paths) => addVideos(queue, parseStrings(paths, 'paths')));

  handle('chooseVideos', async (event) => {
    const files = await showOpenDialog(event, {
      title: 'Add videos',
      buttonLabel: 'Add',
      defaultPath: videoFolder ?? standardFolder('videos'),
      filters: [{ name: 'Videos', extensions: [...VIDEO_EXTENSIONS] }, ALL_FILES],
      properties: ['openFile', 'multiSelections'],
    });
    if (files === null) {
      return null;
    }
    videoFolder = path.dirname(files[0]);
    return addVideos(queue, files);
  });

  handle('removeItems', (_event, ids) => {
    queue.remove(parseIds(ids));
  });

  handle('clearItems', (_event, scope) => {
    queue.clear(parseClearScope(scope));
  });

  handle('resetItems', (_event, ids) => {
    queue.reset(parseIds(ids));
  });

  handle('startProcessing', async (_event, value) => {
    const recipe = parseRecipe(value);
    // Checked now: the file may have been moved since the list last looked.
    const track =
      recipe.audio === 'replace' && recipe.trackId !== null
        ? await library.check(recipe.trackId)
        : null;
    const { output } = store.settings();
    const issue = toolsIssue(tools) ?? recipeIssue(recipe, track) ?? (await outputIssue(output));
    if (issue !== null) {
      throw new Error(issue);
    }
    return queue.start(recipe, output, track === null ? null : { path: track.path });
  });

  handle('cancelProcessing', (_event, ids) => {
    queue.cancel(ids === null ? null : parseIds(ids));
  });

  handle('openItem', async (_event, id, file) => {
    const error = await shell.openPath(await itemFilePath(queue, id, file));
    if (error !== '') {
      throw new Error(error);
    }
  });

  handle('revealItem', async (_event, id, file) => {
    shell.showItemInFolder(await itemFilePath(queue, id, file));
  });

  handle('listTracks', () => {
    // Tracks found missing or back are announced through `tracksChanged`.
    void library.refresh();
    return library.list();
  });

  handle('addTracks', (_event, paths) => library.add(parseStrings(paths, 'paths')));

  handle('chooseTracks', async (event) => {
    const files = await showOpenDialog(event, {
      title: 'Add audio files',
      buttonLabel: 'Add',
      defaultPath: trackFolder ?? standardFolder('music'),
      filters: [{ name: 'Audio files', extensions: [...AUDIO_EXTENSIONS] }, ALL_FILES],
      properties: ['openFile', 'multiSelections'],
    });
    if (files === null) {
      return null;
    }
    trackFolder = path.dirname(files[0]);
    return library.add(files);
  });

  handle('removeTrack', (_event, id) => {
    library.remove(parseId(id));
  });

  handle('getSettings', () => store.settings());

  handle('updateSettings', (_event, patch) => store.update(parseSettingsPatch(patch)));

  handle('chooseOutputFolder', async (event) => {
    const folders = await showOpenDialog(event, {
      title: 'Choose where to save the videos',
      buttonLabel: 'Choose',
      defaultPath: store.settings().output.folder ?? standardFolder('videos'),
      properties: ['openDirectory', 'createDirectory'],
    });
    return folders === null ? null : folders[0];
  });
}

/** What the main process found on this computer, for `getEnvironment`. */
export function environmentOf(
  tools: MediaTools | null,
  appVersion: string,
  dataDir: string,
): Environment {
  return {
    appVersion,
    ffmpeg:
      tools === null
        ? null
        : { path: tools.ffmpeg, version: tools.version, supported: isSupported(tools) },
    dataDir,
  };
}

/**
 * Why nothing can be processed with this ffmpeg; `null` when it can, or when there is none (the
 * videos are then unsupported, and none is queued). The renderer says so before a run.
 */
export function toolsIssue(tools: MediaTools | null): string | null {
  return tools === null || isSupported(tools)
    ? null
    : `ffmpeg ${MIN_FFMPEG_VERSION} or later is needed; this one is ${tools.version}.`;
}

/** Sends a change to every window still open. */
export function broadcast(
  channel: typeof IpcChannel.itemsChanged | typeof IpcChannel.tracksChanged,
  payload: readonly QueueItem[] | readonly AudioTrack[],
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
}

/** Adds the videos among `paths`, folders walked; used for drops, dialogs and "Open with". */
export async function addVideos(
  queue: Pick<Queue, 'add'>,
  paths: readonly string[],
): Promise<AddResult> {
  const { files, ignored, truncated } = await expandPaths(paths, {
    extensions: VIDEO_EXTENSIONS,
    folders: true,
  });
  const { added, duplicates } = files.length === 0 ? { added: 0, duplicates: 0 } : queue.add(files);
  return { added, duplicates, ignored, truncated };
}

/** The source or the output of an item, once it is sure to be on disk. */
export async function itemFilePath(
  queue: Pick<Queue, 'sourcePath' | 'outputPath'>,
  idValue: unknown,
  fileValue: unknown,
): Promise<string> {
  const id = parseId(idValue);
  const file = parseItemFile(fileValue);
  const target = file === 'source' ? queue.sourcePath(id) : queue.outputPath(id);
  if (target === null) {
    throw new Error(
      file === 'source'
        ? 'This video is no longer in the list.'
        : 'This video has not been processed yet.',
    );
  }
  if (!(await exists(target))) {
    throw new Error(`${path.basename(target)} cannot be found: it was moved or deleted.`);
  }
  return target;
}

/** Why videos cannot be saved where the settings say; `null` when they can. */
export async function outputIssue(output: OutputSettings): Promise<string | null> {
  if (output.location === 'beside') {
    return null;
  }
  if (output.folder === null) {
    return 'Choose the folder to save the videos in.';
  }
  const stats = await stat(output.folder).catch(() => null);
  return stats?.isDirectory() === true
    ? null
    : `The output folder ${output.folder} cannot be found: choose another one.`;
}

function invalid(what: string): Error {
  return new Error(`Invalid ${what}.`);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= MAX_ID_LENGTH;
}

function fieldsOf(value: unknown, what: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw invalid(what);
  }
  return value;
}

export function parseStrings(value: unknown, what: string): string[] {
  if (Array.isArray(value) && value.length <= MAX_LIST_LENGTH) {
    const entries = value as unknown[];
    if (entries.every((entry): entry is string => typeof entry === 'string')) {
      return [...entries];
    }
  }
  throw invalid(what);
}

export function parseId(value: unknown): string {
  if (!isId(value)) {
    throw invalid('id');
  }
  return value;
}

export function parseIds(value: unknown): string[] {
  const ids = parseStrings(value, 'ids');
  if (!ids.every(isId)) {
    throw invalid('ids');
  }
  return ids;
}

export function parseItemFile(value: unknown): ItemFile {
  if (value !== 'source' && value !== 'output') {
    throw invalid('file');
  }
  return value;
}

export function parseClearScope(value: unknown): ClearScope {
  if (value !== 'all' && value !== 'finished') {
    throw invalid('scope');
  }
  return value;
}

/**
 * Checks the shape only: a recipe the user got wrong (a negative length, a fraction of a frame)
 * is for `recipeIssue` to explain, in words meant for them.
 */
export function parseRecipe(value: unknown): Recipe {
  const { audio, trackId, loop, trimStart, trimEnd, precision } = fieldsOf(value, 'recipe');
  if (
    !isAudioMode(audio) ||
    !(trackId === null || isId(trackId)) ||
    typeof loop !== 'boolean' ||
    !isCutPrecision(precision)
  ) {
    throw invalid('recipe');
  }
  return {
    audio,
    trackId,
    loop,
    trimStart: parseTrim(trimStart),
    trimEnd: parseTrim(trimEnd),
    precision,
  };
}

function parseTrim(value: unknown): Trim {
  const { amount, unit } = fieldsOf(value, 'trim');
  if (typeof amount !== 'number' || !isTrimUnit(unit)) {
    throw invalid('trim');
  }
  return { amount, unit };
}

export function parseOutput(value: unknown): OutputSettings {
  const { location, folder } = fieldsOf(value, 'output settings');
  if (
    !isOutputLocation(location) ||
    !(folder === null || (typeof folder === 'string' && path.isAbsolute(folder)))
  ) {
    throw invalid('output settings');
  }
  return { location, folder };
}

export function parseSettingsPatch(value: unknown): Partial<Settings> {
  const patch = fieldsOf(value, 'settings');
  if (Object.keys(patch).some((key) => key !== 'recipe' && key !== 'output')) {
    throw invalid('settings');
  }
  const { recipe, output } = patch;
  return {
    ...(recipe === undefined ? {} : { recipe: parseRecipe(recipe) }),
    ...(output === undefined ? {} : { output: parseOutput(output) }),
  };
}

/** The files chosen, at least one; `null` when the dialog was canceled. */
async function showOpenDialog(
  event: IpcMainInvokeEvent,
  options: OpenDialogOptions,
): Promise<[string, ...string[]] | null> {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  const [first, ...others] = result.filePaths;
  return result.canceled || first === undefined ? null : [first, ...others];
}

/** Where a dialog starts the first time: the user's Videos or Music folder, else their home. */
function standardFolder(name: 'videos' | 'music'): string {
  try {
    return app.getPath(name);
  } catch {
    return app.getPath('home');
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
