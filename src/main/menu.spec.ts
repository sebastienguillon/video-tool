import type { MenuItem, MenuItemConstructorOptions, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { appMenuTemplate } from './menu';
import { MAX_ZOOM_LEVEL, MIN_ZOOM_LEVEL, ZOOM_STEP } from './zoom';

const getFocusedWebContents = vi.hoisted(() => vi.fn<() => WebContents | null>());
vi.mock('electron', () => ({ Menu: {}, webContents: { getFocusedWebContents } }));

/** The View menu's items. */
function viewItems(platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  const view = appMenuTemplate(platform).find((menu) => menu.label === 'View');
  return view?.submenu as MenuItemConstructorOptions[];
}

describe('appMenuTemplate', () => {
  it('is the default menu of Electron, with the app menu on macOS only', () => {
    const roles = (platform: NodeJS.Platform): (string | undefined)[] =>
      appMenuTemplate(platform).map((menu) => menu.role ?? menu.label);
    expect(roles('darwin')).toEqual(['appMenu', 'fileMenu', 'editMenu', 'View', 'windowMenu']);
    expect(roles('win32')).toEqual(['fileMenu', 'editMenu', 'View', 'windowMenu']);
    expect(viewItems('linux').map((item) => item.role ?? item.label ?? item.type)).toEqual([
      'reload',
      'forceReload',
      'toggleDevTools',
      'separator',
      'Actual Size',
      'Zoom In',
      'Zoom Out',
      'separator',
      'togglefullscreen',
    ]);
  });

  it('zooms the focused page within the limits', () => {
    const page = { zoomLevel: 0 };
    getFocusedWebContents.mockReturnValue(page as WebContents);
    const click = (label: string): void => {
      const item = viewItems('linux').find((candidate) => candidate.label === label);
      item?.click?.({} as MenuItem, undefined, {});
    };

    click('Zoom In');
    expect(page.zoomLevel).toBe(ZOOM_STEP);
    for (let step = 0; step < 100; step++) {
      click('Zoom In');
    }
    expect(page.zoomLevel).toBe(MAX_ZOOM_LEVEL);
    click('Actual Size');
    expect(page.zoomLevel).toBe(0);
    for (let step = 0; step < 100; step++) {
      click('Zoom Out');
    }
    expect(page.zoomLevel).toBe(MIN_ZOOM_LEVEL);

    getFocusedWebContents.mockReturnValue(null);
    click('Zoom In');
    expect(page.zoomLevel).toBe(MIN_ZOOM_LEVEL);
  });
});
