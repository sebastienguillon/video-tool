import type { ClearScope } from '@shared/desktop-api';
import { createLogger } from '@shared/log';
import type {
  AudioTrack,
  ItemState,
  ItemStateKind,
  OutputSettings,
  QueueItem,
  Recipe,
} from '@shared/model';
import { PROCESSABLE_STATES } from '@shared/model';
import { recipeIssue, videoIssue } from '@shared/recipe';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { errorMessage } from './media/exec';
import type { ReplacementTrack } from './media/job';
import { JobError, pathKey, processVideo } from './media/job';
import type { MediaTools } from './media/media-tools';
import type { MediaProbe } from './media/probe';
import { probeVideo, UnsupportedMediaError } from './media/probe';
import type { Progress } from './media/runner';
import { CanceledError, FfmpegError } from './media/runner';

const log = createLogger('queue');

/** ffprobe runs at once while videos are added: enough to keep up, not enough to choke a drive. */
const PROBE_CONCURRENCY = 4;
/** Changes the user did not make (see `QueueOptions.onChange`) are emitted at most this often. */
const EMIT_INTERVAL_MS = 200;

const TOOLS_MISSING = 'ffmpeg was not found: install it, then restart Video Tool.';
const FINISHED: readonly ItemStateKind[] = ['done', 'failed', 'canceled', 'unsupported'];
const RESETTABLE: readonly ItemStateKind[] = ['done', 'failed', 'canceled'];

export interface QueueOptions {
  /** `null` when ffmpeg/ffprobe were not found: added items become `unsupported`, saying so. */
  readonly tools: MediaTools | null;
  /**
   * Called after changes with the whole list. What the user does (adding, removing, starting,
   * canceling…) is emitted at once. What happens on its own (probe results, progress, videos
   * starting and finishing) is coalesced, at most ~5 times per second: probing a folder of
   * thousands of videos, or failing them one after the other, would otherwise send the whole list
   * thousands of times, faster than the window can take it.
   */
  readonly onChange: (items: readonly QueueItem[]) => void;
}

/** How a queued item is to be processed: what `start` was given. */
interface Job {
  readonly recipe: Recipe;
  readonly output: OutputSettings;
  readonly track: ReplacementTrack | null;
}

interface Entry {
  item: QueueItem;
  /** For duplicate detection. */
  readonly key: string;
  probe: MediaProbe | null;
  job: Job | null;
  /** Aborts its probe. */
  probing: AbortController | null;
  removed: boolean;
}

interface Run {
  readonly entry: Entry;
  readonly controller: AbortController;
  /** Undoes the job synchronously while it has a partial file (see `abortNow`). */
  abortNow: (() => void) | null;
}

/**
 * The video list and its processing. Videos are probed in the background as they are added, then
 * processed one at a time, in the order they were queued, each in one ffmpeg pass. The list
 * belongs to the main process; the renderer sees it through `onChange`.
 */
export class Queue {
  private readonly options: QueueOptions;
  private entries: Entry[] = [];
  private readonly byId = new Map<string, Entry>();
  /** Ids of queued items, in processing order. */
  private pending: string[] = [];
  private running: Run | null = null;
  /** Probes and the run in progress, which `dispose` waits for. */
  private readonly tasks = new Set<Promise<void>>();
  private readonly limitProbes = createLimiter(PROBE_CONCURRENCY);
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEmit = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(options: QueueOptions) {
    this.options = options;
  }

  list(): readonly QueueItem[] {
    return this.entries.map((entry) => entry.item);
  }

  /**
   * Adds video files (folders are expanded and extensions filtered before). A path already listed
   * counts as a duplicate. New items are probed in the background.
   */
  add(files: readonly string[]): { readonly added: number; readonly duplicates: number } {
    const known = new Set(this.entries.map((entry) => entry.key));
    const { tools } = this.options;
    let added = 0;
    let duplicates = 0;
    for (const file of files) {
      const resolved = path.resolve(file);
      const key = pathKey(resolved);
      if (known.has(key)) {
        duplicates++;
        continue;
      }
      known.add(key);
      const entry: Entry = {
        item: {
          id: randomUUID(),
          path: resolved,
          name: path.basename(resolved),
          folder: path.dirname(resolved),
          info: null,
          state:
            tools === null ? { kind: 'unsupported', message: TOOLS_MISSING } : { kind: 'probing' },
        },
        key,
        probe: null,
        job: null,
        probing: null,
        removed: false,
      };
      this.entries.push(entry);
      this.byId.set(entry.item.id, entry);
      added++;
      if (tools !== null) {
        this.probe(entry, tools);
      }
    }
    if (added > 0) {
      this.emit();
    }
    return { added, duplicates };
  }

  /** Removes items; a queued one is unqueued, a running one canceled first (its partial file deleted). */
  remove(ids: readonly string[]): void {
    const targets = new Set(ids);
    const removed = this.entries.filter((entry) => targets.has(entry.item.id));
    if (removed.length === 0) {
      return;
    }
    for (const entry of removed) {
      entry.removed = true;
      entry.probing?.abort();
      this.byId.delete(entry.item.id);
      if (this.running?.entry === entry) {
        this.running.controller.abort();
      }
    }
    this.entries = this.entries.filter((entry) => !entry.removed);
    this.pending = this.pending.filter((id) => this.byId.has(id));
    this.emit();
  }

  /** `all` (canceling what runs or waits) or `finished` (done, failed, canceled, unsupported). */
  clear(scope: ClearScope): void {
    this.remove(
      this.entries
        .filter((entry) => scope === 'all' || FINISHED.includes(entry.item.state.kind))
        .map((entry) => entry.item.id),
    );
  }

  /** Puts done, failed or canceled items back to `ready`; others are left as they are. */
  reset(ids: readonly string[]): void {
    let changed = false;
    for (const id of ids) {
      const entry = this.byId.get(id);
      if (entry !== undefined && RESETTABLE.includes(entry.item.state.kind)) {
        entry.item = { ...entry.item, state: { kind: 'ready' } };
        changed = true;
      }
    }
    if (changed) {
      this.emit();
    }
  }

  /**
   * Queues every item in a `PROCESSABLE_STATES` state with `recipe`; returns how many. Those the
   * recipe cannot apply to fail at once, saying why. `track` is the replacement soundtrack, needed
   * when the recipe replaces the audio. While a run is going, the new items join its end, with
   * their own recipe. Throws when the recipe cannot run at all.
   */
  start(recipe: Recipe, output: OutputSettings, track: ReplacementTrack | null): number {
    const issue = recipeIssue(recipe, track === null ? null : audioTrackOf(recipe, track));
    if (issue !== null) {
      throw new Error(issue);
    }
    const job: Job = { recipe, output, track: recipe.audio === 'replace' ? track : null };
    let changed = false;
    let queued = 0;
    for (const entry of this.entries) {
      if (entry.probe === null || !PROCESSABLE_STATES.includes(entry.item.state.kind)) {
        continue;
      }
      changed = true;
      const problem = videoIssue(recipe, entry.probe.info);
      if (problem === null) {
        entry.job = job;
        entry.item = { ...entry.item, state: { kind: 'queued' } };
        this.pending.push(entry.item.id);
        queued++;
      } else {
        entry.item = { ...entry.item, state: { kind: 'failed', message: problem } };
      }
    }
    if (changed) {
      this.emit();
    }
    this.next();
    return queued;
  }

  /**
   * Cancels the given queued or running items, or all (`null`). Queued ones are canceled at once;
   * a running one once ffmpeg has exited and its partial file is deleted.
   */
  cancel(ids: readonly string[] | null): void {
    const targets = ids === null ? null : new Set(ids);
    let changed = false;
    for (const entry of this.entries) {
      if (targets !== null && !targets.has(entry.item.id)) {
        continue;
      }
      if (entry.item.state.kind === 'queued') {
        entry.job = null;
        entry.item = { ...entry.item, state: { kind: 'canceled' } };
        changed = true;
      } else if (this.running?.entry === entry) {
        this.running.controller.abort();
      }
    }
    if (changed) {
      this.pending = this.pending.filter((id) => this.byId.get(id)?.item.state.kind === 'queued');
      this.emit();
    }
  }

  /** Whether anything is queued or running. */
  busy(): boolean {
    return this.entries.some(
      ({ item }) => item.state.kind === 'queued' || item.state.kind === 'running',
    );
  }

  sourcePath(id: string): string | null {
    return this.byId.get(id)?.item.path ?? null;
  }

  /** The result of a `done` item; `null` otherwise. */
  outputPath(id: string): string | null {
    const state = this.byId.get(id)?.item.state;
    return state?.kind === 'done' ? state.outputPath : null;
  }

  /** Cancels everything; resolves once every ffmpeg and ffprobe has exited and partial files are deleted. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancel(null);
    for (const entry of this.entries) {
      entry.probing?.abort();
    }
    await Promise.allSettled([...this.tasks]);
    if (this.emitTimer !== null) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
  }

  /**
   * Stops the running ffmpeg and deletes its partial file before returning, for when the app is
   * about to end without its quit flow: Windows ending the session (shutdown, restart, sign-out)
   * ends the process right after the event, before anything asynchronous could run. Kills
   * ffmpeg with its child processes, and blocks until they are gone and the file is deleted
   * (a few seconds at most). Nothing else starts afterwards; item states are left as they are.
   */
  abortNow(): void {
    this.disposed = true;
    const run = this.running;
    if (run === null) {
      return;
    }
    run.abortNow?.();
    // Should the process live on, the run settles as canceled.
    run.controller.abort();
  }

  private probe(entry: Entry, tools: MediaTools): void {
    const controller = new AbortController();
    entry.probing = controller;
    this.track(
      // Removed while waiting for a slot: the aborted signal stops ffprobe from starting.
      this.limitProbes(async () => {
        try {
          const probe = await probeVideo(tools, entry.item.path, controller.signal);
          entry.probe = probe;
          this.update(entry, { ...entry.item, info: probe.info, state: { kind: 'ready' } });
        } catch (error) {
          if (controller.signal.aborted) {
            return;
          }
          if (!(error instanceof UnsupportedMediaError)) {
            log.warn(`Cannot probe ${entry.item.path}:`, errorMessage(error));
          }
          const message =
            error instanceof UnsupportedMediaError ? error.message : 'This file cannot be read.';
          this.update(entry, { ...entry.item, state: { kind: 'unsupported', message } });
        } finally {
          entry.probing = null;
        }
      }),
    );
  }

  /** Starts the next queued item, unless one is running. */
  private next(): void {
    const { tools } = this.options;
    if (this.running !== null || this.disposed || tools === null) {
      return;
    }
    let entry: Entry | undefined;
    while (entry === undefined || entry.job === null || entry.probe === null) {
      const id = this.pending.shift();
      if (id === undefined) {
        return;
      }
      entry = this.byId.get(id);
    }
    const run: Run = { entry, controller: new AbortController(), abortNow: null };
    this.running = run;
    entry.item = { ...entry.item, state: { kind: 'running', progress: null, speed: null } };
    this.emitSoon();
    this.track(
      this.process(run, tools, entry.job, entry.probe).finally(() => {
        this.running = null;
        this.next();
      }),
    );
  }

  private async process(run: Run, tools: MediaTools, job: Job, probe: MediaProbe): Promise<void> {
    const { entry, controller } = run;
    let state: ItemState;
    try {
      const outputPath = await processVideo({
        tools,
        source: entry.item.path,
        probe,
        recipe: job.recipe,
        output: job.output,
        track: job.track,
        signal: controller.signal,
        onProgress: (progress) => {
          this.progress(entry, progress);
        },
        onAbortNow: (abortNow) => {
          run.abortNow = abortNow;
        },
      });
      state = { kind: 'done', outputPath };
    } catch (error) {
      state = stateAfter(error, controller.signal);
    }
    entry.job = null;
    this.update(entry, { ...entry.item, state });
  }

  private progress(entry: Entry, { progress, speed }: Progress): void {
    const { state } = entry.item;
    if (entry.removed || state.kind !== 'running') {
      return;
    }
    entry.item = {
      ...entry.item,
      state: { kind: 'running', progress: progress ?? state.progress, speed: speed ?? state.speed },
    };
    this.emitSoon();
  }

  /** Replaces an item, unless it was removed meanwhile; the change goes out with the next emission. */
  private update(entry: Entry, item: QueueItem): void {
    if (!entry.removed) {
      entry.item = item;
      this.emitSoon();
    }
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }

  /** Emits at once, with whatever was waiting to go out. */
  private emit(): void {
    if (this.emitTimer !== null) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this.lastEmit = performance.now();
    this.options.onChange(this.list());
  }

  /** Emits now if the last emission is old enough, else once it is. */
  private emitSoon(): void {
    if (this.emitTimer !== null) {
      return;
    }
    const wait = this.lastEmit + EMIT_INTERVAL_MS - performance.now();
    if (wait <= 0) {
      this.emit();
      return;
    }
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit();
    }, wait);
  }
}

/** Where an item stands after its run threw. */
function stateAfter(error: unknown, signal: AbortSignal): ItemState {
  if (error instanceof CanceledError || signal.aborted) {
    return { kind: 'canceled' };
  }
  if (error instanceof JobError || error instanceof FfmpegError) {
    return { kind: 'failed', message: error.message };
  }
  log.error('Processing failed:', error);
  return { kind: 'failed', message: `Something went wrong: ${errorMessage(error)}` };
}

/** The audio list entry `recipeIssue` checks, for the replacement soundtrack given to `start`. */
function audioTrackOf(recipe: Recipe, track: ReplacementTrack): AudioTrack {
  let present: boolean;
  try {
    present = statSync(track.path).isFile();
  } catch {
    present = false;
  }
  return {
    id: recipe.trackId ?? '',
    path: track.path,
    name: path.basename(track.path),
    suffix: track.suffix,
    durationSec: null,
    status: present ? 'ok' : 'missing',
  };
}

/** Runs at most `concurrency` tasks at once, the others waiting in FIFO order. */
function createLimiter(concurrency: number): (task: () => Promise<void>) => Promise<void> {
  let active = 0;
  const waiting: (() => void)[] = [];
  // A finishing task hands its slot straight to the next one, so newcomers cannot overtake it.
  const release = (): void => {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      active--;
    }
  };
  return async (task) => {
    if (active < concurrency) {
      active++;
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      await task();
    } finally {
      release();
    }
  };
}
