import type { MenuItemConstructorOptions } from 'electron';
import { Menu, webContents } from 'electron';
import type { ZoomCommand } from './zoom';
import { zoom } from './zoom';

/**
 * Electron's default menu, except for View › Actual Size, Zoom In and Zoom Out, which zoom as the
 * keys and the wheel do (see `handleZoom`): by the same steps, within the same limits. Electron's
 * own zoom items have no limits.
 */
export function appMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  const zoomItem = (
    label: string,
    accelerator: string,
    command: ZoomCommand,
  ): MenuItemConstructorOptions => ({
    label,
    accelerator,
    // The page that has the focus, as Electron's items do: the developer tools' too.
    click: () => {
      const focused = webContents.getFocusedWebContents();
      if (focused !== null) {
        zoom(focused, command);
      }
    },
  });
  return [
    ...(platform === 'darwin' ? [{ role: 'appMenu' } as const] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        zoomItem('Actual Size', 'CommandOrControl+0', 'reset'),
        zoomItem('Zoom In', 'CommandOrControl+Plus', 'in'),
        zoomItem('Zoom Out', 'CommandOrControl+-', 'out'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
}

/** Must run once the app is ready, before the window opens. */
export function setAppMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(process.platform)));
}
