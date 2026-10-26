import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { DESKTOP } from '../../core/desktop';
import type { QueueItem } from '@shared/model';
import { FakeDesktop, queueItem, settle } from '../../testing/fake-desktop';
import { VideoList } from './video-list';

describe('VideoList', () => {
  let desktop: FakeDesktop;
  let fixture: ComponentFixture<VideoList>;
  let host: HTMLElement;

  beforeEach(async () => {
    desktop = new FakeDesktop();
    desktop.items = [
      queueItem('a'),
      queueItem('b', { state: { kind: 'running', progress: 0.2, speed: 1 } }),
      queueItem('c'),
    ];
    TestBed.configureTestingModule({ providers: [{ provide: DESKTOP, useValue: desktop }] });
    fixture = TestBed.createComponent(VideoList);
    host = fixture.nativeElement as HTMLElement;
    document.body.append(host);
    await settle();
    await fixture.whenStable();
  });

  afterEach(() => {
    host.remove();
  });

  const rows = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('li')];
  const button = (label: string): HTMLButtonElement | null =>
    host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  /** Activates a button from the keyboard: it has the focus, then it is pressed. */
  const pressButton = (label: string): void => {
    button(label)?.focus();
    button(label)?.click();
  };
  const emit = async (items: readonly QueueItem[]): Promise<void> => {
    desktop.emitItems(items);
    await fixture.whenStable();
  };
  const press = (row: HTMLElement | undefined, key: string): void => {
    row?.focus();
    row?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  };

  it('lists the videos as named rows', () => {
    expect(host.querySelector('ul')?.getAttribute('aria-label')).toBe('Videos');
    expect(rows().map((row) => row.getAttribute('aria-label'))).toEqual([
      'a.mp4',
      'b.mp4',
      'c.mp4',
    ]);
  });

  it('removes the focused row with Delete or Backspace, and focuses the next one', () => {
    press(rows()[0], 'Delete');
    expect(desktop.callsTo('removeItems')).toEqual([[['a']]]);
    expect(document.activeElement).toBe(rows()[1]);

    press(rows()[2], 'Backspace');
    expect(desktop.callsTo('removeItems')).toEqual([[['a']], [['c']]]);
    expect(document.activeElement).toBe(rows()[1]);
  });

  it('does not remove a video being processed', () => {
    press(rows()[1], 'Delete');
    expect(desktop.callsTo('removeItems')).toEqual([]);
  });

  it('leaves the keys pressed on the buttons of a row to them', () => {
    const remove = rows()[0]?.querySelector<HTMLButtonElement>(
      '[aria-label="Remove a.mp4 from the list"]',
    );
    remove?.focus();
    remove?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(desktop.callsTo('removeItems')).toEqual([]);

    remove?.click();
    expect(desktop.callsTo('removeItems')).toEqual([[['a']]]);
    expect(document.activeElement).toBe(rows()[1]);
  });

  it('keeps the focus on the row when Cancel, Retry or Process again give way to other buttons', async () => {
    pressButton('Cancel b.mp4');
    expect(desktop.callsTo('cancelProcessing')).toEqual([[['b']]]);
    expect(document.activeElement).toBe(rows()[1]);
    await emit([queueItem('a'), queueItem('b', { state: { kind: 'canceled' } }), queueItem('c')]);
    expect(button('Cancel b.mp4')).toBeNull();
    expect(document.activeElement).toBe(rows()[1]);

    await emit([
      queueItem('a', { state: { kind: 'done', outputPath: 'D:\\a (no audio).mp4' } }),
      queueItem('b', { state: { kind: 'failed', message: 'The disk is full.' } }),
      queueItem('c'),
    ]);
    pressButton('Process a.mp4 again');
    expect(document.activeElement).toBe(rows()[0]);
    pressButton('Retry b.mp4');
    expect(document.activeElement).toBe(rows()[1]);
    expect(desktop.callsTo('resetItems')).toEqual([[['a']], [['b']]]);
    await emit([queueItem('a'), queueItem('b'), queueItem('c')]);
    expect(document.activeElement).toBe(rows()[1]);
  });

  it('leaves the focus alone when a button is clicked while it is elsewhere', () => {
    const elsewhere = rows()[2];
    elsewhere?.focus();
    button('Cancel b.mp4')?.click();
    expect(document.activeElement).toBe(elsewhere);
  });

  it('moves between rows with the arrow keys, Home and End', () => {
    press(rows()[0], 'ArrowDown');
    expect(document.activeElement).toBe(rows()[1]);
    press(rows()[1], 'End');
    expect(document.activeElement).toBe(rows()[2]);
    press(rows()[2], 'ArrowUp');
    expect(document.activeElement).toBe(rows()[1]);
    press(rows()[1], 'Home');
    expect(document.activeElement).toBe(rows()[0]);
  });
});
