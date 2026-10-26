import { BrowserWindow, nativeTheme } from 'electron';

export interface MainWindowOptions {
  readonly url: string;
  readonly preload: string;
}

/** Matches the renderer's background tokens, so the window never flashes white on open. */
const BACKGROUND = { light: '#f6f6f7', dark: '#141518' } as const;

/**
 * `scheme://host[:port]` of `url`; `null` when it is not a URL. Node's `URL.origin` is `"null"` for
 * schemes it does not know, `app:` included: comparing those would let `file:` or `data:` pages
 * pass for the app.
 */
export function originOf(url: string): string | null {
  const parsed = URL.parse(url);
  return parsed === null ? null : `${parsed.protocol}//${parsed.host.toLowerCase()}`;
}

export function createMainWindow({ url, preload }: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 800,
    minHeight: 540,
    show: false,
    title: 'Video Tool',
    backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
    // On macOS the toolbar doubles as the title bar.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } }
      : { autoHideMenuBar: true }),
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  // The app never leaves its own pages: this also keeps a video dropped outside the drop zone from
  // replacing the app (Chromium would navigate to it).
  const origin = originOf(url);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => {
    if (originOf(target) !== origin) {
      event.preventDefault();
    }
  });

  void window.loadURL(url);
  return window;
}

export interface SessionEndHooks {
  /** Whether ending the session now would lose work. */
  readonly busy: () => boolean;
  /** Synchronous: the app exits as soon as it returns. */
  readonly end: () => void;
}

/**
 * Windows only. A shutdown, a restart or a log-off skips `before-quit` and `will-quit`, and the app
 * exits as soon as `session-end` returns. While `busy`, Windows is asked to wait: it lists the app
 * among those keeping the session from ending, where the user can cancel. If it ends anyway, `end`
 * is the last chance to clean up.
 */
export function guardSessionEnd(window: BrowserWindow, { busy, end }: SessionEndHooks): void {
  window.on('query-session-end', (event) => {
    if (busy()) {
      event.preventDefault();
    }
  });
  window.on('session-end', () => {
    end();
  });
}
