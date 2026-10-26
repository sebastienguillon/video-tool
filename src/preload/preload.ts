/**
 * Sandboxed preload: exposes `window.videoTool`, the renderer's only way to the main process. Each
 * call is an `invoke` on its `IpcChannel`; the main process checks every argument.
 */
import type { DesktopBridge } from '@shared/desktop-api';
import { IpcChannel } from '@shared/desktop-api';
import type { AudioTrack, QueueItem } from '@shared/model';
import type { IpcRendererEvent } from 'electron';
import { contextBridge, ipcRenderer, webUtils } from 'electron';

/** Bridge methods the main process answers: all but `platform`, `pathForFile` and subscriptions. */
type InvokeMethod = keyof DesktopBridge & keyof typeof IpcChannel;

function invoke<K extends InvokeMethod>(method: K): DesktopBridge[K] {
  const channel = IpcChannel[method];
  return ((...args: unknown[]) => ipcRenderer.invoke(channel, ...args)) as DesktopBridge[K];
}

/** Calls `listener` with what the main process sends on `channel`; the function returned stops. */
function subscribe(channel: string, listener: (payload: unknown) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: unknown): void => {
    listener(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const bridge: DesktopBridge = {
  platform: process.platform,
  // `File.path` is gone since Electron 32.
  pathForFile: (file) => webUtils.getPathForFile(file),
  getEnvironment: invoke('getEnvironment'),
  listItems: invoke('listItems'),
  addVideos: invoke('addVideos'),
  chooseVideos: invoke('chooseVideos'),
  removeItems: invoke('removeItems'),
  clearItems: invoke('clearItems'),
  resetItems: invoke('resetItems'),
  startProcessing: invoke('startProcessing'),
  cancelProcessing: invoke('cancelProcessing'),
  openItem: invoke('openItem'),
  revealItem: invoke('revealItem'),
  onItemsChanged: (listener) =>
    subscribe(IpcChannel.itemsChanged, (items) => {
      listener(items as readonly QueueItem[]);
    }),
  listTracks: invoke('listTracks'),
  addTracks: invoke('addTracks'),
  chooseTracks: invoke('chooseTracks'),
  removeTrack: invoke('removeTrack'),
  setTrackSuffix: invoke('setTrackSuffix'),
  onTracksChanged: (listener) =>
    subscribe(IpcChannel.tracksChanged, (tracks) => {
      listener(tracks as readonly AudioTrack[]);
    }),
  getSettings: invoke('getSettings'),
  updateSettings: invoke('updateSettings'),
  chooseOutputFolder: invoke('chooseOutputFolder'),
};

contextBridge.exposeInMainWorld('videoTool', bridge);
