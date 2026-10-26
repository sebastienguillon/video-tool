import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { DEFAULT_RECIPE, DEFAULT_SETTINGS } from '@shared/model';
import { App } from './app';
import { DESKTOP } from './core/desktop';
import { EnvironmentStore } from './core/environment-store';
import { SettingsStore } from './core/settings-store';
import { environment, FakeDesktop, queueItem, settle, text } from './testing/fake-desktop';

interface FakeTransfer {
  readonly types: readonly string[];
  readonly files: readonly File[];
  dropEffect: string;
}

describe('App', () => {
  let desktop: FakeDesktop;
  let fixture: ComponentFixture<App>;
  let host: HTMLElement;

  beforeEach(() => {
    desktop = new FakeDesktop();
    TestBed.configureTestingModule({ providers: [{ provide: DESKTOP, useValue: desktop }] });
  });

  const render = async (): Promise<void> => {
    await settle();
    await fixture.whenStable();
  };
  /** As the app initializer does, then shows the window. */
  const mount = async (): Promise<void> => {
    await TestBed.inject(SettingsStore).load();
    await TestBed.inject(EnvironmentStore).load();
    fixture = TestBed.createComponent(App);
    host = fixture.nativeElement as HTMLElement;
    await render();
  };
  /**
   * Dispatches a drag event from `target`, carrying `files` (or text, for `null`). `related` is the
   * element the drag comes from (enter) or goes to (leave): `null` outside the window.
   */
  const drag = (
    type: string,
    files: readonly File[] | null,
    target: Element | null = host.querySelector('.stage'),
    related: Element | null = null,
  ): { event: Event; transfer: FakeTransfer } => {
    const transfer: FakeTransfer = {
      types: files === null ? ['text/plain'] : ['Files'],
      files: files ?? [],
      dropEffect: 'none',
    };
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    Object.defineProperty(event, 'relatedTarget', { value: related });
    target?.dispatchEvent(event);
    return { event, transfer };
  };
  const status = (): string => text(host.querySelector('.status [role="status"]'));

  it('adds dropped videos and folders, leaving out what is not on this computer', async () => {
    desktop.respond('pathForFile', (file) =>
      file.name === 'page.html' ? '' : `D:\\Vidéos\\${file.name}`,
    );
    desktop.respond('addVideos', () =>
      Promise.resolve({ added: 3, duplicates: 1, ignored: 1, truncated: false }),
    );
    await mount();
    const files = [
      new File([''], 'a.mp4'),
      new File([''], 'été 日本'),
      new File([''], 'page.html'),
    ];

    drag('dragenter', files);
    const { event: over, transfer } = drag('dragover', files);
    expect(over.defaultPrevented).toBe(true);
    expect(transfer.dropEffect).toBe('copy');
    await render();
    expect(text(host.querySelector('.zone.active h2'))).toBe('Drop to add');

    const { event: drop } = drag('drop', files);
    expect(drop.defaultPrevented).toBe(true);
    await render();
    expect(desktop.callsTo('addVideos')).toEqual([[['D:\\Vidéos\\a.mp4', 'D:\\Vidéos\\été 日本']]]);
    expect(status()).toBe('3 videos added · 1 already in the list · 2 files ignored: not videos');
    expect(host.querySelector('.zone.active')).toBeNull();
  });

  it('shows Drop to add over the list while files are dragged, from element to element', async () => {
    desktop.items = [queueItem('clip')];
    await mount();
    const files = [new File([''], 'b.mp4')];
    const stage = host.querySelector('.stage');
    const row = host.querySelector('li');

    // As Chromium does: the next element is entered, then the previous one is left.
    drag('dragenter', files);
    drag('dragenter', files, row, stage);
    drag('dragleave', files, stage, row);
    await render();
    expect(text(host.querySelector('.overlay'))).toBe('Drop to add');

    drag('dragleave', files, row, null);
    await render();
    expect(host.querySelector('.overlay')).toBeNull();
  });

  it('hides Drop to add once the drag leaves the window, even if a leave got lost', async () => {
    desktop.items = [queueItem('clip')];
    await mount();
    const files = [new File([''], 'b.mp4')];
    const stage = host.querySelector('.stage');
    const row = host.querySelector('li');
    const name = row?.querySelector('.name') ?? null;

    drag('dragenter', files);
    drag('dragenter', files, row, stage);
    drag('dragleave', files, stage, row);
    // The row is rendered again under the pointer: the leave of the old element never arrives.
    drag('dragenter', files, name, row);
    drag('dragleave', files, name, null);
    await render();
    expect(host.querySelector('.overlay')).toBeNull();
  });

  it('keeps saying, in a warning, that a drop stopped at the folder limit', async () => {
    desktop.respond('addVideos', () =>
      Promise.resolve({ added: 5_000, duplicates: 0, ignored: 0, truncated: true }),
    );
    await mount();
    const files = [new File([''], 'Archive')];
    drag('dragenter', files);
    drag('drop', files);
    await render();
    expect(status()).toBe(
      '5,000 videos added · stopped at 5,000 videos from folders: drop the rest separately',
    );
    expect(host.querySelector('.status [role="status"]')?.classList).toContain('warning-text');
  });

  it('gives the focus to Choose videos when the last video leaves the list', async () => {
    desktop.items = [queueItem('clip')];
    await mount();
    document.body.append(host);
    try {
      const row = host.querySelector<HTMLElement>('li');
      row?.focus();
      row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', cancelable: true }));
      expect(desktop.callsTo('removeItems')).toEqual([[['clip']]]);
      desktop.emitItems([]);
      await render();
      expect(document.activeElement?.textContent.trim()).toBe('Choose videos…');
    } finally {
      host.remove();
    }
  });

  it('gives the focus to Add videos after Clear finished, which gets disabled', async () => {
    desktop.items = [
      queueItem('a', { state: { kind: 'done', outputPath: 'D:\\a (no audio).mp4' } }),
      queueItem('b'),
    ];
    await mount();
    document.body.append(host);
    try {
      const clear = [...host.querySelectorAll<HTMLButtonElement>('app-toolbar button')].find(
        (button) => text(button) === 'Clear finished',
      );
      clear?.focus();
      clear?.click();
      expect(desktop.callsTo('clearItems')).toEqual([['finished']]);
      desktop.emitItems([queueItem('b')]);
      await render();
      expect(clear?.disabled).toBe(true);
      expect(text(document.activeElement)).toBe('Add videos…');
    } finally {
      host.remove();
    }
  });

  it('leaves drags without files alone', async () => {
    await mount();
    drag('dragenter', null);
    const { event } = drag('dragover', null);
    expect(event.defaultPrevented).toBe(false);
    drag('drop', null);
    await render();
    expect(host.querySelector('.zone.active')).toBeNull();
    expect(desktop.callsTo('addVideos')).toEqual([]);
  });

  it('adds audio files dropped on the audio list to it, not to the videos', async () => {
    desktop.settings = { ...DEFAULT_SETTINGS, recipe: { ...DEFAULT_RECIPE, audio: 'replace' } };
    desktop.respond('addTracks', () =>
      Promise.resolve({ added: 1, duplicates: 0, ignored: 0, truncated: false }),
    );
    await mount();
    const files = [new File([''], 'song.mp3')];
    const tracks = host.querySelector('app-track-list');

    drag('dragenter', files, tracks);
    drag('dragover', files, tracks);
    await render();
    expect(text(host.querySelector('.drop-overlay'))).toBe('Drop to add to the audio list');
    expect(host.querySelector('.zone.active')).toBeNull();

    drag('drop', files, tracks);
    await render();
    expect(desktop.callsTo('addTracks')).toEqual([[['D:\\Vidéos\\song.mp3']]]);
    expect(desktop.callsTo('addVideos')).toEqual([]);
    expect(text(tracks?.querySelector('[role="status"]'))).toBe('1 audio file added');
  });

  it('says how to install ffmpeg when it is missing, and processes nothing', async () => {
    desktop.items = [queueItem('clip')];
    desktop.respond('getEnvironment', () => Promise.resolve({ ...environment, ffmpeg: null }));
    await mount();
    expect(text(host.querySelector('.banner'))).toBe(
      'ffmpeg was not found. Install it, then restart Video Tool: winget install Gyan.FFmpeg',
    );
    const process = host.querySelector('app-process-bar button');
    expect(process?.getAttribute('aria-disabled')).toBe('true');
    expect(text(host.querySelector('#process-reason'))).toBe('Install ffmpeg to process videos.');
  });

  it('says which ffmpeg is needed when the one found is too old, and processes nothing', async () => {
    desktop.items = [queueItem('clip')];
    const outdated = (version: string) =>
      Promise.resolve({
        ...environment,
        ffmpeg: { path: 'C:\\tools\\ffmpeg.exe', version, supported: false },
      });
    desktop.respond('getEnvironment', () => outdated('3.2.4-full_build-www.gyan.dev'));
    await mount();
    expect(text(host.querySelector('.banner'))).toBe(
      'ffmpeg 4.4 or later is needed; this one is 3.2.4. Update it, then restart Video Tool: winget install Gyan.FFmpeg',
    );
    const process = host.querySelector('app-process-bar button');
    expect(process?.getAttribute('aria-disabled')).toBe('true');
    expect(text(host.querySelector('#process-reason'))).toBe('Update ffmpeg to process videos.');
  });

  it('gives the command that updates ffmpeg on macOS, and none on Linux', async () => {
    const outdated = (version: string) =>
      Promise.resolve({
        ...environment,
        ffmpeg: { path: '/usr/bin/ffmpeg', version, supported: false },
      });
    desktop.platform = 'darwin';
    desktop.respond('getEnvironment', () => outdated('3.3.9'));
    await mount();
    expect(text(host.querySelector('.banner'))).toBe(
      'ffmpeg 4.4 or later is needed; this one is 3.3.9. Update it, then restart Video Tool: brew upgrade ffmpeg',
    );
    TestBed.resetTestingModule();
    desktop = new FakeDesktop();
    desktop.platform = 'linux';
    desktop.respond('getEnvironment', () => outdated('N-90012-g8c57a84a2a'));
    TestBed.configureTestingModule({ providers: [{ provide: DESKTOP, useValue: desktop }] });
    await mount();
    // A build from git: its name says no version.
    expect(text(host.querySelector('.banner'))).toBe(
      'ffmpeg 4.4 or later is needed; this one is N-90012-g8c57a84a2a. Update it, then restart Video Tool.',
    );
    expect(host.querySelector('.banner code')).toBeNull();
  });

  it('shows no warning when ffmpeg is there', async () => {
    await mount();
    expect(host.querySelector('.banner')).toBeNull();
  });

  it('asks for videos with Ctrl+O', async () => {
    await mount();
    const event = new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(desktop.callsTo('chooseVideos')).toHaveLength(1);
  });
});
