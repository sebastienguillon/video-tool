import { TestBed } from '@angular/core/testing';
import type { QueueItem } from '@shared/model';
import { FakeDesktop, queueItem, settle } from '../testing/fake-desktop';
import { DESKTOP } from './desktop';
import { ItemsStore } from './items-store';

const running = (progress: number | null): QueueItem['state'] => ({
  kind: 'running',
  progress,
  speed: null,
});

describe('ItemsStore', () => {
  let desktop: FakeDesktop;

  beforeEach(() => {
    desktop = new FakeDesktop();
    TestBed.configureTestingModule({ providers: [{ provide: DESKTOP, useValue: desktop }] });
  });

  const create = async (): Promise<ItemsStore> => {
    const store = TestBed.inject(ItemsStore);
    await settle();
    return store;
  };

  it('lists the videos, then follows the changes', async () => {
    desktop.items = [queueItem('a')];
    const store = await create();
    expect(store.items().map((item) => item.id)).toEqual(['a']);

    desktop.emitItems([queueItem('a'), queueItem('b')]);
    expect(store.items().map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('ignores an initial listing that a change overtook', async () => {
    const listing = Promise.withResolvers<readonly QueueItem[]>();
    desktop.respond('listItems', () => listing.promise);
    const store = await create();
    desktop.emitItems([queueItem('a'), queueItem('b')]);
    listing.resolve([queueItem('a')]);
    await settle();
    expect(store.items().map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('keeps the objects of the items that did not change, so that their rows are not rendered again', async () => {
    const store = await create();
    desktop.emitItems([queueItem('a'), queueItem('b')]);
    const [a, b] = store.items();

    desktop.emitItems([queueItem('a'), queueItem('b', { state: running(0.1) })]);
    expect(store.items()[0]).toBe(a);
    expect(store.items()[1]).not.toBe(b);

    const list = store.items();
    desktop.emitItems([queueItem('a'), queueItem('b', { state: running(0.1) })]);
    expect(store.items()).toBe(list);
  });

  it('follows the overall progress of a run, then says how it went', async () => {
    const store = await create();
    desktop.emitItems([
      queueItem('a', { state: { kind: 'queued' } }),
      queueItem('b', { state: { kind: 'queued' } }),
      queueItem('c'),
    ]);
    expect(store.busy()).toBe(true);
    expect(store.progress()).toEqual({ finished: 0, total: 2, fraction: 0 });

    desktop.emitItems([
      queueItem('a', { state: running(0.5) }),
      queueItem('b', { state: { kind: 'queued' } }),
      queueItem('c'),
    ]);
    expect(store.progress()).toEqual({ finished: 0, total: 2, fraction: 0.25 });

    desktop.emitItems([
      queueItem('a', { state: { kind: 'done', outputPath: 'D:\\a (no audio).mp4' } }),
      queueItem('b', { state: running(0.5) }),
      queueItem('c'),
    ]);
    expect(store.progress()).toEqual({ finished: 1, total: 2, fraction: 0.75 });
    expect(store.notice()).toBeNull();

    desktop.emitItems([
      queueItem('a', { state: { kind: 'done', outputPath: 'D:\\a (no audio).mp4' } }),
      queueItem('b', { state: { kind: 'failed', message: 'The disk is full.' } }),
      queueItem('c'),
    ]);
    expect(store.busy()).toBe(false);
    expect(store.progress()).toBeNull();
    expect(store.notice()?.text).toBe('Processing finished: 1 done · 1 failed');
    expect(store.finishedCount()).toBe(2);
  });

  it('counts videos queued during a run as part of it', async () => {
    const store = await create();
    desktop.emitItems([queueItem('a', { state: running(0.5) }), queueItem('b')]);
    desktop.emitItems([
      queueItem('a', { state: running(0.5) }),
      queueItem('b', { state: { kind: 'queued' } }),
    ]);
    expect(store.progress()).toEqual({ finished: 0, total: 2, fraction: 0.25 });
  });

  it('says what adding did, and why it failed', async () => {
    desktop.respond('addVideos', () =>
      Promise.resolve({ added: 2, duplicates: 0, ignored: 0, truncated: false }),
    );
    const store = await create();
    await store.add(['D:\\Vidéos\\a.mp4', 'D:\\Vidéos\\été']);
    expect(desktop.callsTo('addVideos')).toEqual([[['D:\\Vidéos\\a.mp4', 'D:\\Vidéos\\été']]]);
    expect(store.notice()).toEqual({ text: '2 videos added', tone: 'info' });

    desktop.respond('removeItems', () =>
      Promise.reject(
        new Error("Error invoking remote method 'items:remove': Error: The list is locked."),
      ),
    );
    await store.remove(['a']);
    expect(store.notice()).toEqual({
      text: 'Cannot remove from the list: The list is locked.',
      tone: 'error',
    });
  });

  it('keeps saying that a drop stopped at the folder limit, until the next message', async () => {
    vi.useFakeTimers();
    try {
      desktop.respond('addVideos', () =>
        Promise.resolve({ added: 5_000, duplicates: 0, ignored: 0, truncated: true }),
      );
      const store = await create();
      await store.add(['E:\\Archive']);
      vi.advanceTimersByTime(60_000);
      expect(store.notice()).toEqual({
        text: '5,000 videos added · stopped at 5,000 videos from folders: drop the rest separately',
        tone: 'warning',
      });

      desktop.respond('chooseVideos', () =>
        Promise.resolve({ added: 1, duplicates: 0, ignored: 0, truncated: false }),
      );
      await store.choose();
      expect(store.notice()).toEqual({ text: '1 video added', tone: 'info' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('says nothing was added when no dropped item is a file on this computer', async () => {
    const store = await create();
    await store.add([], 2);
    expect(desktop.callsTo('addVideos')).toEqual([]);
    expect(store.notice()?.text).toBe('Only files on this computer can be added.');
  });
});
