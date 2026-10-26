import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import type { ItemState, QueueItem } from '@shared/model';
import { DESKTOP } from '../../core/desktop';
import { SettingsStore } from '../../core/settings-store';
import { FakeDesktop, info, queueItem, settle, text } from '../../testing/fake-desktop';
import { VideoRow } from './video-row';

describe('VideoRow', () => {
  let desktop: FakeDesktop;
  let fixture: ComponentFixture<VideoRow>;
  let host: HTMLElement;

  beforeEach(() => {
    desktop = new FakeDesktop();
    TestBed.configureTestingModule({ providers: [{ provide: DESKTOP, useValue: desktop }] });
  });

  const show = async (item: QueueItem): Promise<void> => {
    fixture = TestBed.createComponent(VideoRow);
    host = fixture.nativeElement as HTMLElement;
    fixture.componentRef.setInput('item', item);
    await settle();
    await fixture.whenStable();
  };
  const inState = (state: ItemState): QueueItem => queueItem('clip', { state });
  const button = (label: string): HTMLButtonElement | null =>
    host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  it('shows the name, the folder and what ffprobe found', async () => {
    await show(queueItem('clip'));
    const name = host.querySelector('.name');
    expect(text(name)).toBe('clip.mp4');
    expect(name?.getAttribute('title')).toBe('D:\\Vidéos\\été 日本\\clip.mp4');
    expect(text(host.querySelector('.folder'))).toBe('D:\\Vidéos\\été 日本');
    expect(text(host.querySelector('.details'))).toBe(
      '1:05 · 1920×1080 · 29.97 fps · H.264 · AAC · 12.3 MB',
    );
    expect(host.querySelector('img')?.getAttribute('src')).toBe('thumb://video/clip');
    expect(text(host.querySelector('.side .status'))).toBe('');
  });

  it('says when a video has no sound', async () => {
    await show(queueItem('clip', { info: { ...info, audioCodec: null, frameRate: null } }));
    expect(text(host.querySelector('.details'))).toBe(
      '1:05 · 1920×1080 · H.264 · no audio · 12.3 MB',
    );
  });

  it('opens the source from its name', async () => {
    await show(queueItem('clip'));
    host.querySelector<HTMLButtonElement>('.name')?.click();
    expect(desktop.callsTo('openItem')).toEqual([['clip', 'source']]);
  });

  it('shows the source in the file manager from its folder, whatever the video stands', async () => {
    await show(queueItem('clip'));
    const folder = button('Show in Explorer: clip.mp4');
    expect(text(folder)).toBe('D:\\Vidéos\\été 日本');
    expect(folder?.getAttribute('title')).toBe('Show in Explorer: D:\\Vidéos\\été 日本');
    folder?.click();
    expect(desktop.callsTo('revealItem')).toEqual([['clip', 'source']]);

    await show(
      queueItem('clip', { info: null, state: { kind: 'unsupported', message: 'Not a video.' } }),
    );
    button('Show in Explorer: clip.mp4')?.click();
    await show(inState({ kind: 'running', progress: 0.5, speed: 1 }));
    button('Show in Explorer: clip.mp4')?.click();
    expect(desktop.callsTo('revealItem')).toHaveLength(3);
  });

  it('asks for no still while the video is read, nor for one that is not supported', async () => {
    await show(queueItem('clip', { info: null, state: { kind: 'probing' } }));
    expect(host.querySelector('img')).toBeNull();
    expect(text(host.querySelector('.status'))).toBe('Reading…');

    await show(
      queueItem('clip', {
        info: null,
        state: { kind: 'unsupported', message: 'This file has no video.' },
      }),
    );
    expect(host.querySelector('img')).toBeNull();
    expect(text(host.querySelector('.message'))).toBe('This file has no video.');
    expect(text(host.querySelector('.status'))).toBe('Not supported');
    expect(button('Remove clip.mp4 from the list')).not.toBeNull();
  });

  it('falls back to the placeholder when the still cannot be loaded', async () => {
    await show(queueItem('clip'));
    host.querySelector('img')?.dispatchEvent(new Event('error'));
    await fixture.whenStable();
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.placeholder')).not.toBeNull();
  });

  it('offers to cancel a video waiting or being processed', async () => {
    await show(inState({ kind: 'queued' }));
    expect(text(host.querySelector('.status'))).toBe('Waiting');
    button('Cancel clip.mp4')?.click();
    expect(desktop.callsTo('cancelProcessing')).toEqual([[['clip']]]);
    expect(button('Remove clip.mp4 from the list')).toBeNull();
  });

  it('shows the progress of a video being processed', async () => {
    await show(inState({ kind: 'running', progress: 0.437, speed: 2.14 }));
    const bar = host.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('43');
    expect(bar?.getAttribute('aria-label')).toBe('Processing clip.mp4');
    expect(text(host.querySelector('.running .status'))).toBe('43% · 2.1×');
    expect(button('Cancel clip.mp4')).not.toBeNull();

    await show(inState({ kind: 'running', progress: null, speed: null }));
    expect(host.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false);
    expect(text(host.querySelector('.running .status'))).toBe('Starting…');
  });

  it('opens or shows the result of a video done, or gets it ready again', async () => {
    await show(inState({ kind: 'done', outputPath: 'D:\\Vidéos\\clip (no audio).mp4' }));
    expect(text(host.querySelector('.status'))).toBe('Done');
    button('Open the result of clip.mp4')?.click();
    button('Show in Explorer: the result of clip.mp4')?.click();
    button('Process clip.mp4 again')?.click();
    expect(desktop.callsTo('openItem')).toEqual([['clip', 'output']]);
    expect(desktop.callsTo('revealItem')).toEqual([['clip', 'output']]);
    expect(desktop.callsTo('resetItems')).toEqual([[['clip']]]);
  });

  it('names the file manager of the platform', async () => {
    desktop.platform = 'darwin';
    await show(inState({ kind: 'done', outputPath: '/Users/seb/clip (no audio).mp4' }));
    expect(button('Show in Finder: the result of clip.mp4')).not.toBeNull();
    expect(button('Show in Finder: clip.mp4')).not.toBeNull();
  });

  it('says why a video failed, and offers to retry it', async () => {
    await show(inState({ kind: 'failed', message: 'The disk is full.' }));
    expect(text(host.querySelector('.message'))).toBe('The disk is full.');
    expect(text(host.querySelector('.status'))).toBe('Failed');
    button('Retry clip.mp4')?.click();
    expect(desktop.callsTo('resetItems')).toEqual([[['clip']]]);
  });

  it('shows a canceled video as such', async () => {
    await show(inState({ kind: 'canceled' }));
    expect(text(host.querySelector('.status'))).toBe('Canceled');
  });

  it('warns about a video the treatments cannot apply to, unless it is done', async () => {
    TestBed.inject(SettingsStore).updateRecipe({ trimStart: { amount: 70, unit: 'seconds' } });
    await show(queueItem('clip'));
    expect(text(host.querySelector('.message'))).toBe('The trims remove all of it (1:05 long).');

    await show(inState({ kind: 'done', outputPath: 'D:\\Vidéos\\clip (no audio).mp4' }));
    expect(host.querySelector('.message')).toBeNull();
  });
});
