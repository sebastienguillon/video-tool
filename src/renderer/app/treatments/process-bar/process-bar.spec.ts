import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import type { QueueItem, Recipe } from '@shared/model';
import { DEFAULT_RECIPE } from '@shared/model';
import { DESKTOP } from '../../core/desktop';
import { SettingsStore } from '../../core/settings-store';
import { audioTrack, FakeDesktop, info, queueItem, settle, text } from '../../testing/fake-desktop';
import { ProcessBar } from './process-bar';

describe('ProcessBar', () => {
  let desktop: FakeDesktop;
  let settings: SettingsStore;
  let fixture: ComponentFixture<ProcessBar>;
  let host: HTMLElement;

  beforeEach(async () => {
    desktop = new FakeDesktop();
    desktop.items = [
      queueItem('a'),
      queueItem('b'),
      queueItem('c', { state: { kind: 'done', outputPath: 'D:\\c (no audio).mp4' } }),
      queueItem('d', { info: null, state: { kind: 'probing' } }),
      queueItem('e', { state: { kind: 'failed', message: 'The disk is full.' } }),
      queueItem('f', { info: null, state: { kind: 'unsupported', message: 'Not a video.' } }),
    ];
    TestBed.configureTestingModule({ providers: [{ provide: DESKTOP, useValue: desktop }] });
    settings = TestBed.inject(SettingsStore);
    fixture = TestBed.createComponent(ProcessBar);
    host = fixture.nativeElement as HTMLElement;
    await render();
  });

  async function render(): Promise<void> {
    await settle();
    await fixture.whenStable();
  }

  const button = (): HTMLButtonElement => host.querySelector('button') as HTMLButtonElement;
  const reason = (): string => text(host.querySelector('#process-reason'));
  const unavailable = (): boolean => button().getAttribute('aria-disabled') === 'true';
  const recipe = async (patch: Partial<Recipe>): Promise<void> => {
    settings.updateRecipe(patch);
    await render();
  };
  const items = async (list: readonly QueueItem[]): Promise<void> => {
    desktop.emitItems(list);
    await render();
  };

  it('counts the videos a run would process', () => {
    expect(text(button())).toBe('Process 3 videos');
    expect(unavailable()).toBe(false);
    expect(button().hasAttribute('aria-describedby')).toBe(false);
  });

  it('leaves out the videos the treatments cannot apply to', async () => {
    await items([queueItem('a'), queueItem('short', { info: { ...info, durationSec: 4 } })]);
    await recipe({ trimEnd: { amount: 5, unit: 'seconds' } });
    expect(text(button())).toBe('Process 1 video');

    await recipe({ trimEnd: { amount: 70, unit: 'seconds' } });
    expect(text(button())).toBe('Process videos');
    expect(reason()).toBe('None of the videos can take these treatments.');
  });

  it('says why it cannot process, and keeps the focus where it is', async () => {
    await recipe({ audio: 'keep' });
    expect(unavailable()).toBe(true);
    expect(reason()).toBe('Choose what to do: remove or replace the audio, or trim.');
    expect(button().getAttribute('aria-describedby')).toBe('process-reason');
    button().click();
    await render();
    expect(desktop.callsTo('startProcessing')).toEqual([]);

    await recipe({ audio: 'replace' });
    expect(reason()).toBe('Choose the replacement audio.');

    desktop.emitTracks([audioTrack('gone', { status: 'missing', durationSec: null })]);
    await recipe({ trackId: 'gone' });
    expect(reason()).toBe('gone.mp3 is missing: it was moved or deleted.');

    await recipe({ audio: 'remove' });
    settings.setTrimValidity('trimEnd', false);
    await render();
    expect(reason()).toBe('Enter a valid length to trim.');
    settings.setTrimValidity('trimEnd', true);

    await settings.setOutput({ location: 'folder', folder: null });
    await render();
    expect(reason()).toBe('Choose the folder to save in.');
  });

  it('says why there is nothing to process', async () => {
    await items([]);
    expect(reason()).toBe('Add videos to process.');
    await items([queueItem('d', { info: null, state: { kind: 'probing' } })]);
    expect(reason()).toBe('Reading the videos…');
    await items([queueItem('c', { state: { kind: 'done', outputPath: 'D:\\c.mp4' } })]);
    expect(reason()).toBe('Nothing left to process. Use Process again on a video to redo it.');
  });

  it('says when no file of the list can be read as a video, without offering Process again', async () => {
    const unreadable = (id: string): QueueItem =>
      queueItem(id, { info: null, state: { kind: 'unsupported', message: 'Not a video.' } });
    await items([unreadable('f')]);
    expect(reason()).toBe('This file cannot be read as a video.');
    await items([unreadable('f'), unreadable('g')]);
    expect(reason()).toBe('None of these files can be read as a video.');
    await items([
      unreadable('f'),
      queueItem('c', { state: { kind: 'done', outputPath: 'D:\\c.mp4' } }),
    ]);
    expect(reason()).toBe('Nothing left to process. Use Process again on a video to redo it.');
  });

  it('saves the treatments, then starts processing with them', async () => {
    await recipe({ trimStart: { amount: 2, unit: 'seconds' } });
    button().click();
    await render();
    expect(desktop.calls.map((call) => call.method).slice(-2)).toEqual([
      'updateSettings',
      'startProcessing',
    ]);
    expect(desktop.callsTo('startProcessing')).toEqual([
      [{ ...DEFAULT_RECIPE, trimStart: { amount: 2, unit: 'seconds' } }],
    ]);
  });

  it('says why processing could not start', async () => {
    desktop.respond('startProcessing', () =>
      Promise.reject(
        new Error("Error invoking remote method 'items:start': Error: The output folder is gone."),
      ),
    );
    button().click();
    await render();
    expect(text(host.querySelector('[role="alert"]'))).toBe('The output folder is gone.');
  });

  it('shows the overall progress of a run, and stops it', async () => {
    await items([
      queueItem('a', { state: { kind: 'done', outputPath: 'D:\\a (no audio).mp4' } }),
      queueItem('b', { state: { kind: 'running', progress: 0.5, speed: 3 } }),
      queueItem('c', { state: { kind: 'queued' } }),
      queueItem('d'),
    ]);
    // `a` was done before this run.
    expect(text(host.querySelector('.run-text'))).toBe('0 of 2 done · 25%');
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25');

    await items([
      queueItem('a', { state: { kind: 'done', outputPath: 'D:\\a (no audio).mp4' } }),
      queueItem('b', { state: { kind: 'done', outputPath: 'D:\\b (no audio).mp4' } }),
      queueItem('c', { state: { kind: 'running', progress: 0.2, speed: 3 } }),
      queueItem('d'),
    ]);
    expect(text(host.querySelector('.run-text'))).toBe('1 of 2 done · 60%');

    button().click();
    expect(text(button())).toBe('Stop all');
    expect(desktop.callsTo('cancelProcessing')).toEqual([[null]]);
  });
});
