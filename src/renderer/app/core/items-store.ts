import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import type { ClearScope, ItemFile } from '@shared/desktop-api';
import { createLogger } from '@shared/log';
import type { AddResult, ItemStateKind, QueueItem, Recipe } from '@shared/model';
import { DESKTOP, ipcErrorMessage } from './desktop';
import { describeAdd, NoticeBoard } from './notice';

const log = createLogger('items');

/** Overall progress of the videos a run picked up. */
export interface RunProgress {
  /** Done, failed or canceled. */
  readonly finished: number;
  readonly total: number;
  /** 0 to 1, the video being processed counting for its own progress. */
  readonly fraction: number;
}

function isActive(kind: ItemStateKind): boolean {
  return kind === 'queued' || kind === 'running';
}

/** The ones `clearItems('finished')` removes. */
function isFinished(kind: ItemStateKind): boolean {
  return kind === 'done' || kind === 'failed' || kind === 'canceled' || kind === 'unsupported';
}

/**
 * The video list, as the main process sends it after every change, and the actions on it.
 *
 * Progress makes the whole list arrive a few times a second. Items that did not change keep their
 * previous object, so that only the rows of those that did are rendered again.
 */
@Injectable({ providedIn: 'root' })
export class ItemsStore {
  private readonly desktop = inject(DESKTOP);
  private readonly list = signal<readonly QueueItem[]>([]);
  /** Ids of the items picked up by the current run (or the last one). */
  private readonly run = signal<ReadonlySet<string>>(new Set());
  private readonly board = new NoticeBoard();
  /** A change arrived: the initial listing, if still on its way, is older. */
  private changed = false;

  readonly items = this.list.asReadonly();
  /** What the last action on the list did, for the status line. */
  readonly notice = this.board.notice;
  /** Some videos are queued or being processed. */
  readonly busy = computed(() => this.list().some((item) => isActive(item.state.kind)));
  readonly finishedCount = computed(
    () => this.list().filter((item) => isFinished(item.state.kind)).length,
  );
  /** `null` when nothing is being processed. */
  readonly progress = computed<RunProgress | null>(() =>
    this.busy() ? runProgress(this.list(), this.run()) : null,
  );

  constructor() {
    const unsubscribe = this.desktop.onItemsChanged((items) => {
      this.changed = true;
      this.apply(items);
    });
    inject(DestroyRef).onDestroy(unsubscribe);
    this.desktop
      .listItems()
      .then((items) => {
        if (!this.changed) {
          this.apply(items);
        }
      })
      .catch((error: unknown) => {
        log.error('Cannot list the videos:', error);
      });
  }

  /** Adds videos and folders by path, then says what was added. */
  async add(paths: readonly string[], skipped = 0): Promise<void> {
    if (paths.length === 0) {
      this.board.info('Only files on this computer can be added.');
      return;
    }
    try {
      this.report(await this.desktop.addVideos(paths), skipped);
    } catch (error) {
      log.warn('Cannot add videos:', error);
      this.board.error(`Cannot add the videos: ${ipcErrorMessage(error)}`);
    }
  }

  async choose(): Promise<void> {
    try {
      const result = await this.desktop.chooseVideos();
      if (result) {
        this.report(result);
      }
    } catch (error) {
      log.warn('Cannot add videos:', error);
      this.board.error(`Cannot add the videos: ${ipcErrorMessage(error)}`);
    }
  }

  remove(ids: readonly string[]): Promise<void> {
    return this.attempt(() => this.desktop.removeItems(ids), 'Cannot remove from the list');
  }

  clear(scope: ClearScope): Promise<void> {
    return this.attempt(() => this.desktop.clearItems(scope), 'Cannot clear the list');
  }

  /** Back to `ready`, to be processed again. */
  reset(ids: readonly string[]): Promise<void> {
    return this.attempt(() => this.desktop.resetItems(ids), 'Cannot process it again');
  }

  /** `null`: every queued and running video. */
  cancel(ids: readonly string[] | null): Promise<void> {
    return this.attempt(() => this.desktop.cancelProcessing(ids), 'Cannot stop processing');
  }

  open(item: QueueItem, file: ItemFile): Promise<void> {
    return this.attempt(() => this.desktop.openItem(item.id, file), `Cannot open ${item.name}`);
  }

  reveal(item: QueueItem, file: ItemFile): Promise<void> {
    return this.attempt(() => this.desktop.revealItem(item.id, file), `Cannot show ${item.name}`);
  }

  /** Queues every video that can be processed; rejects with a readable message. */
  async start(recipe: Recipe): Promise<void> {
    try {
      await this.desktop.startProcessing(recipe);
    } catch (error) {
      log.warn('Cannot start processing:', error);
      throw new Error(ipcErrorMessage(error), { cause: error });
    }
  }

  /**
   * A drop that stopped at the folder limit stays on screen: the videos left out need another drop,
   * and the user must not take the list for complete.
   */
  private report(result: AddResult, skipped = 0): void {
    const text = describeAdd(result, 'videos', skipped);
    if (result.truncated) {
      this.board.warning(text);
    } else {
      this.board.info(text);
    }
  }

  private async attempt(action: () => Promise<void>, failure: string): Promise<void> {
    try {
      await action();
    } catch (error) {
      log.warn(`${failure}:`, error);
      this.board.error(`${failure}: ${ipcErrorMessage(error)}`);
    }
  }

  private apply(incoming: readonly QueueItem[]): void {
    const previous = this.list();
    const next = reconcile(previous, incoming);
    if (next === previous) {
      return;
    }
    const wasBusy = previous.some((item) => isActive(item.state.kind));
    const active = next.filter((item) => isActive(item.state.kind)).map((item) => item.id);
    if (active.length > 0) {
      // A run picks up what is queued when it starts, and what gets queued while it goes on.
      const run = new Set(wasBusy ? [...this.run(), ...active] : active);
      if (!wasBusy || run.size !== this.run().size) {
        this.run.set(run);
      }
    } else if (wasBusy) {
      const outcome = describeRun(next, this.run());
      if (outcome !== null) {
        this.board.info(outcome);
      }
    }
    this.list.set(next);
  }
}

function runProgress(items: readonly QueueItem[], run: ReadonlySet<string>): RunProgress {
  let total = 0;
  let finished = 0;
  let done = 0;
  for (const { id, state } of items) {
    if (!run.has(id)) {
      continue;
    }
    switch (state.kind) {
      case 'queued':
        total++;
        break;
      case 'running':
        total++;
        done += state.progress ?? 0;
        break;
      case 'done':
      case 'failed':
      case 'canceled':
        total++;
        finished++;
        done++;
        break;
      // Put back to `ready`, or removed from the list: no longer part of the run.
      case 'probing':
      case 'ready':
      case 'unsupported':
        break;
    }
  }
  return { finished, total, fraction: total === 0 ? 0 : Math.min(1, done / total) };
}

/** `Processing finished: 3 done · 1 failed`; `null` when nothing of the run is left to tell. */
function describeRun(items: readonly QueueItem[], run: ReadonlySet<string>): string | null {
  const counts = { done: 0, failed: 0, canceled: 0 };
  for (const { id, state } of items) {
    if (
      run.has(id) &&
      (state.kind === 'done' || state.kind === 'failed' || state.kind === 'canceled')
    ) {
      counts[state.kind]++;
    }
  }
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind}`);
  return parts.length === 0 ? null : `Processing finished: ${parts.join(' · ')}`;
}

/** `incoming`, reusing the objects of `previous` for the items that did not change. */
function reconcile(
  previous: readonly QueueItem[],
  incoming: readonly QueueItem[],
): readonly QueueItem[] {
  const known = new Map(previous.map((item) => [item.id, item]));
  let unchanged = previous.length === incoming.length;
  const next = incoming.map((item, index) => {
    const old = known.get(item.id);
    const kept = old !== undefined && sameItem(old, item) ? old : item;
    unchanged &&= kept === previous[index];
    return kept;
  });
  return unchanged ? previous : next;
}

function sameItem(a: QueueItem, b: QueueItem): boolean {
  return (
    a.path === b.path &&
    a.name === b.name &&
    a.folder === b.folder &&
    sameFields(a.info, b.info) &&
    sameFields(a.state, b.state)
  );
}

/** Whether two flat records hold the same values. */
function sameFields(a: object | null, b: object | null): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null) {
    return false;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.is(left[key], right[key]))
  );
}
