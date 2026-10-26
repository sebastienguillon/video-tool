import { DOCUMENT, inject, InjectionToken } from '@angular/core';
import type { DesktopBridge } from '@shared/desktop-api';

declare global {
  interface Window {
    /** Exposed by the Electron preload script. */
    readonly videoTool?: DesktopBridge;
  }
}

/** Main-process services (video list, audio list, settings, dialogs) exposed by the preload. */
export const DESKTOP = new InjectionToken<DesktopBridge>('DesktopBridge', {
  providedIn: 'root',
  factory: () => {
    const bridge = inject(DOCUMENT).defaultView?.videoTool;
    if (!bridge) {
      throw new Error(
        'Video Tool must run inside its Electron shell (window.videoTool is missing).',
      );
    }
    return bridge;
  },
});

/**
 * The message of an error from a `DesktopBridge` call, without the channel name Electron prefixes
 * to errors thrown in the main process.
 */
export function ipcErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}

/** Label of the action that shows a file in the system's file manager. */
export function revealLabel(platform: string): string {
  switch (platform) {
    case 'darwin':
      return 'Show in Finder';
    case 'win32':
      return 'Show in Explorer';
    default:
      return 'Show in folder';
  }
}
