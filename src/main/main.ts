import { IpcChannel } from '@shared/desktop-api';
import { createLogger } from '@shared/log';
import type { MessageBoxOptions } from 'electron';
import { app, BrowserWindow, dialog, session } from 'electron';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AudioLibrary } from './audio-library';
import { addVideos, broadcast, parseStrings, registerIpc } from './ipc';
import { loadMediaTools } from './media/media-tools';
import { probeAudio } from './media/probe';
import { renderThumbnail } from './media/thumbnail';
import { APP_ORIGIN, contentSecurityPolicy, handleProtocols, registerSchemes } from './protocols';
import { Queue } from './queue';
import { SettingsStore } from './settings-store';
import { launchPaths, pathKey } from './video-files';
import { createMainWindow, guardSessionEnd, originOf } from './window';

const log = createLogger('main');

/** Set by `pnpm dev`: load the renderer from the Angular dev server instead of the bundle. */
const devServer = nonEmpty(process.env['VIDEO_TOOL_DEV_SERVER_URL']);
const rendererUrl = devServer ?? `${APP_ORIGIN}/`;

/** Separate profile (settings, audio list), e.g. for development or tests. */
const userDataOverride = nonEmpty(process.env['VIDEO_TOOL_USER_DATA']);
if (userDataOverride !== null) {
  app.setPath('userData', path.resolve(userDataOverride));
}

/** How long quitting waits for ffmpeg to stop and partial files to go, before giving up. */
const STOP_TIMEOUT_MS = 15_000;

/**
 * Files this launch was asked to open ("Open with", files dropped on the app's icon); not the app
 * folder that development passes to Electron. A running instance gets them as `additionalData`:
 * the `argv` it receives may be reordered.
 */
const launchFiles = launchPaths(process.argv.slice(1), process.cwd()).filter(
  (file) => pathKey(file) !== pathKey(app.getAppPath()),
);

registerSchemes();

/** Files to open, gathered until the video list exists; `openFiles` then adds them at once. */
const pendingFiles = [...launchFiles];
let openFiles = (files: readonly string[]): void => {
  pendingFiles.push(...files);
};
/** Brings the window up, once there can be one. */
let showWindow = (): void => {
  // Starting up: the window is on its way.
};

// macOS opens files through events, which can come before the app is ready.
app.on('open-file', (event, file) => {
  event.preventDefault();
  showWindow();
  openFiles([file]);
});
app.on('second-instance', (_event, _argv, _workingDirectory, additionalData) => {
  showWindow();
  openFiles(filesOf(additionalData));
});

if (app.requestSingleInstanceLock({ files: launchFiles })) {
  main().catch((error: unknown) => {
    log.error('Startup failed:', error);
    app.exit(1);
  });
} else {
  app.quit();
}

async function main(): Promise<void> {
  await app.whenReady();

  // App menu › About Video Tool. The version is shown once, not as "version (build)".
  app.setAboutPanelOptions({
    applicationName: 'Video Tool',
    applicationVersion: app.getVersion(),
    version: '',
    copyright: 'Copyright © 2026 Sébastien Guillon',
  });

  const dataDir = app.getPath('userData');
  const [tools, store] = await Promise.all([
    loadMediaTools(process.resourcesPath),
    SettingsStore.load(dataDir),
  ]);
  if (tools === null) {
    log.warn('ffmpeg or ffprobe was not found: videos cannot be processed.');
  }

  const queue = new Queue({
    tools,
    onChange: (items) => {
      broadcast(IpcChannel.itemsChanged, items);
    },
  });
  const library = new AudioLibrary({
    saved: store.tracks(),
    save: (tracks) => {
      store.setTracks(tracks);
    },
    probe: tools === null ? null : (file) => probeAudio(tools, file),
    onChange: (tracks) => {
      broadcast(IpcChannel.tracksChanged, tracks);
    },
  });
  void library.refresh();

  const trustedOrigin = originOf(rendererUrl);
  if (trustedOrigin === null) {
    throw new Error(`Not a URL: ${rendererUrl}`);
  }
  handleProtocols({
    rendererRoot: path.join(app.getAppPath(), 'dist', 'renderer', 'browser'),
    queue,
    library,
    renderThumbnail:
      tools === null ? null : (file, durationSec) => renderThumbnail(tools, file, durationSec),
  });
  registerIpc({ queue, library, store, tools, trustedOrigin, dataDir });
  hardenSession();

  openFiles = (files) => {
    if (files.length > 0) {
      addVideos(queue, files).catch((error: unknown) => {
        log.error('Cannot add the files to open:', error);
      });
    }
  };
  openFiles(pendingFiles.splice(0));

  // `stopping`: quitting is decided (confirmed, if videos were being processed) and the queue is
  // being disposed of. `stopped`: done, the app may exit.
  let asking = false;
  let stopping = false;
  let stopped = false;

  /** Quits, after asking if videos are being processed. ffmpeg is always stopped first. */
  const quit = async (parent: BrowserWindow | null): Promise<void> => {
    if (asking || stopping) {
      return;
    }
    if (queue.busy()) {
      asking = true;
      const confirmed = await confirmStop(parent).finally(() => {
        asking = false;
      });
      if (!confirmed) {
        // The app must stay within reach, even if its window is gone (closed by the page, say).
        if (process.platform !== 'darwin') {
          showWindow();
        }
        return;
      }
    }
    stopping = true;
    const done = Promise.allSettled([queue.dispose(), store.flush()]).then(() => false);
    if (await Promise.race([done, delay(STOP_TIMEOUT_MS, true)])) {
      log.error(`Processing did not stop within ${STOP_TIMEOUT_MS / 1000} s; quitting anyway.`);
    }
    stopped = true;
    app.quit();
  };

  let window: BrowserWindow | null = null;
  const openWindow = (): BrowserWindow => {
    const opened = createMainWindow({
      url: rendererUrl,
      preload: path.join(import.meta.dirname, 'preload.cjs'),
    });
    opened.on('close', (event) => {
      // Closing the last window quits, except on macOS, where processing goes on without it.
      if (
        stopping ||
        process.platform === 'darwin' ||
        BrowserWindow.getAllWindows().length > 1 ||
        !queue.busy()
      ) {
        return;
      }
      event.preventDefault();
      void quit(opened);
    });
    opened.on('closed', () => {
      if (window === opened) {
        window = null;
      }
    });
    if (process.platform === 'win32') {
      guardSessionEnd(opened, {
        busy: () => queue.busy(),
        end: () => {
          // None of the quit flow runs: ffmpeg is stopped and its partial file deleted right here.
          log.warn('Windows is ending the session: processing stops.');
          queue.abortNow();
          store.flushSync();
        },
      });
    }
    window = opened;
    return opened;
  };
  openWindow();

  showWindow = () => {
    if (stopping) {
      return;
    }
    const shown = window ?? openWindow();
    if (shown.isMinimized()) {
      shown.restore();
    }
    shown.focus();
  };
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && !stopping) {
      openWindow();
    }
  });
  // Audio files moved or put back while the app was in the background.
  app.on('browser-window-focus', () => {
    void library.refresh();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
  app.on('before-quit', (event) => {
    if (stopped) {
      return;
    }
    event.preventDefault();
    void quit(BrowserWindow.getFocusedWindow() ?? window);
  });
  // The renderer saves its last changes as its window closes, after `before-quit` when quitting
  // from the menu: they are written before the app exits. Everything else is stopped and closed by
  // now, and `app.quit()` would do nothing once `will-quit` was prevented: exit.
  app.on('will-quit', (event) => {
    event.preventDefault();
    void store.flush().finally(() => {
      app.exit();
    });
  });
}

/** Asks whether to stop the videos being processed, and quit. */
async function confirmStop(parent: BrowserWindow | null): Promise<boolean> {
  const options: MessageBoxOptions = {
    type: 'warning',
    message: 'Videos are still being processed.',
    detail: 'Quit and stop them? Unfinished videos are deleted; originals are not touched.',
    buttons: ['Keep processing', 'Quit'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return response === 1;
}

/** The files a second instance hands over; none when its data is not what it sends. */
function filesOf(additionalData: unknown): string[] {
  if (typeof additionalData !== 'object' || additionalData === null) {
    return [];
  }
  try {
    return parseStrings((additionalData as { readonly files?: unknown }).files, 'files');
  } catch {
    return [];
  }
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

function hardenSession(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  if (devServer !== null) {
    // In production the `app:` protocol handler sets the CSP; here the dev server's responses need it.
    session.defaultSession.webRequest.onHeadersReceived(
      { urls: [`${devServer}/*`] },
      (details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [contentSecurityPolicy(devServer)],
          },
        });
      },
    );
  }
}
