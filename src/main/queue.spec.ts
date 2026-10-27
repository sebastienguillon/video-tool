import type { QueueItem, Recipe } from '@shared/model';
import { DEFAULT_RECIPE } from '@shared/model';
import { readdirSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as JobModule from './media/job';
import type { JobInput } from './media/job';
import { JobError, processVideo } from './media/job';
import type { MediaTools } from './media/media-tools';
import type * as ProbeModule from './media/probe';
import type { MediaProbe } from './media/probe';
import { probeVideo, UnsupportedMediaError } from './media/probe';
import { CanceledError, FfmpegError } from './media/runner';
import {
  ffmpeg,
  ffmpegMissing,
  rampSource,
  requireTools,
  toneSource,
} from './media/testing/fixtures';
import { Queue } from './queue';

// The real probe and job by default; tests of the queue's own logic replace them.
vi.mock('./media/probe', async (importOriginal) => {
  const actual = await importOriginal<typeof ProbeModule>();
  return { ...actual, probeVideo: vi.fn(actual.probeVideo) };
});
vi.mock('./media/job', async (importOriginal) => {
  const actual = await importOriginal<typeof JobModule>();
  return { ...actual, processVideo: vi.fn(actual.processVideo) };
});

const FAKE_TOOLS: MediaTools = {
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
  version: 'test',
  encoders: new Set(['libx264', 'aac']),
  decodable: new Set(['h264', 'aac']),
  features: { demuxTimeBase: 'demux', fpsMode: '-fps_mode:v' },
};

const REMOVE_AUDIO: Recipe = { ...DEFAULT_RECIPE, audio: 'remove' };
const BESIDE = { location: 'beside', folder: null } as const;

function fakeProbe(file: string, durationSec = 3): MediaProbe {
  return {
    info: {
      durationSec,
      width: 320,
      height: 240,
      frameRate: 30,
      frameCount: durationSec * 30,
      videoCodec: 'h264',
      audioCodec: 'aac',
      container: path.extname(file).slice(1),
      sizeBytes: 1000,
    },
    video: {
      index: 0,
      codec: 'h264',
      pixFmt: 'yuv420p',
      fullRange: false,
      startSec: 0,
      durationSec,
      frameRate: 30,
      frameCount: durationSec * 30,
      bitRate: null,
      rotation: 0,
      fieldOrder: null,
    },
    audio: [{ index: 1, codec: 'aac', channels: 2, layout: 'stereo', startSec: 0 }],
    subtitles: [],
    fonts: [],
    formatStartSec: 0,
    formatBitRate: null,
    bFrames: false,
  };
}

/** A queue whose changes are recorded, with a way to wait for a state of the list. */
function createQueue(tools: MediaTools | null) {
  const changes: (readonly QueueItem[])[] = [];
  const waiters = new Set<() => void>();
  const queue = new Queue({
    tools,
    onChange: (items) => {
      changes.push(items);
      for (const wake of waiters) {
        wake();
      }
    },
  });
  /** Resolves once `predicate` holds, checked on every change and every few milliseconds. */
  const until = (predicate: (items: readonly QueueItem[]) => boolean, timeoutMs = 30_000) =>
    new Promise<readonly QueueItem[]>((resolve, reject) => {
      const stop = () => {
        waiters.delete(check);
        clearInterval(poll);
        clearTimeout(timer);
      };
      const check = () => {
        if (predicate(queue.list())) {
          stop();
          resolve(queue.list());
        }
      };
      const poll = setInterval(check, 5);
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`Timed out; the list is ${JSON.stringify(queue.list())}`));
      }, timeoutMs);
      waiters.add(check);
      check();
    });
  return { queue, changes, until };
}

const kinds = (items: readonly QueueItem[]) => items.map((item) => item.state.kind);

/** Lets pending promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

interface FakeRun {
  readonly input: JobInput;
  readonly finish: (output: string) => void;
  readonly fail: (error: Error) => void;
}

/** Jobs that end when the test says, or when canceled. */
function controlRuns(): FakeRun[] {
  const runs: FakeRun[] = [];
  vi.mocked(processVideo).mockImplementation(
    (input) =>
      new Promise<string>((resolve, reject) => {
        input.signal.addEventListener('abort', () => {
          reject(new CanceledError());
        });
        runs.push({ input, finish: resolve, fail: reject });
      }),
  );
  return runs;
}

describe('Queue', () => {
  const files = ['a', 'b', 'c'].map((name) => path.resolve('videos', `${name}.mp4`));

  afterEach(() => {
    vi.mocked(probeVideo).mockReset();
    vi.mocked(processVideo).mockReset();
    vi.useRealTimers();
  });

  /** A queue holding `files`, probed. */
  async function readyQueue() {
    vi.mocked(probeVideo).mockImplementation((_, file) => Promise.resolve(fakeProbe(file)));
    const setup = createQueue(FAKE_TOOLS);
    setup.queue.add(files);
    await setup.until((items) => items.every((item) => item.state.kind === 'ready'));
    return setup;
  }

  it('adds each file once, probing them in the background, four at a time', async () => {
    const pending: (() => void)[] = [];
    let active = 0;
    let most = 0;
    vi.mocked(probeVideo).mockImplementation(async (_, file) => {
      active++;
      most = Math.max(most, active);
      await new Promise<void>((resolve) => pending.push(resolve));
      active--;
      return fakeProbe(file);
    });
    const { queue, changes, until } = createQueue(FAKE_TOOLS);
    const many = Array.from({ length: 6 }, (_, index) => path.resolve('videos', `${index}.mp4`));
    const duplicate = path.join(path.resolve('videos'), '.', '0.mp4');
    expect(queue.add([...many, duplicate])).toEqual({ added: 6, duplicates: 1 });
    expect(queue.add([many[1]!])).toEqual({ added: 0, duplicates: 1 });
    expect(changes).toHaveLength(1);
    expect(kinds(queue.list())).toEqual(Array<string>(6).fill('probing'));
    expect(queue.list()[0]).toMatchObject({
      path: many[0],
      name: '0.mp4',
      folder: path.resolve('videos'),
      info: null,
    });
    while (pending.length > 0 || active > 0) {
      await settle();
      pending.shift()?.();
    }
    const items = await until((list) => list.every((item) => item.state.kind === 'ready'));
    expect(most).toBe(4);
    expect(items[0]?.info).toEqual(fakeProbe(many[0]!).info);
  });

  it.skipIf(process.platform !== 'win32' && process.platform !== 'darwin')(
    'compares paths case-insensitively where file systems do',
    () => {
      const { queue } = createQueue(null);
      queue.add([path.resolve('Videos', 'Clip.MP4')]);
      expect(queue.add([path.resolve('videos', 'clip.mp4')])).toEqual({ added: 0, duplicates: 1 });
    },
  );

  it('marks files it cannot process unsupported, saying why', async () => {
    vi.mocked(probeVideo).mockImplementation((_, file) =>
      Promise.reject(
        file.endsWith('a.mp4')
          ? new UnsupportedMediaError('No video stream: this is not a video.')
          : new Error('Unexpected'),
      ),
    );
    const { queue, until } = createQueue(FAKE_TOOLS);
    queue.add(files.slice(0, 2));
    const items = await until((list) => list.every((item) => item.state.kind === 'unsupported'));
    expect(items.map((item) => item.state)).toEqual([
      { kind: 'unsupported', message: 'No video stream: this is not a video.' },
      { kind: 'unsupported', message: 'This file cannot be read.' },
    ]);
    expect(queue.start(REMOVE_AUDIO, BESIDE, null)).toBe(0);
  });

  it('says ffmpeg is missing when it is', () => {
    const { queue } = createQueue(null);
    queue.add(files.slice(0, 1));
    expect(queue.list()[0]?.state).toEqual({
      kind: 'unsupported',
      message: 'ffmpeg was not found: install it, then restart Video Tool.',
    });
    expect(probeVideo).not.toHaveBeenCalled();
  });

  it('refuses a recipe that cannot run', async () => {
    const { queue } = await readyQueue();
    expect(() => queue.start({ ...DEFAULT_RECIPE, audio: 'keep' }, BESIDE, null)).toThrow(
      'Choose what to do: remove or replace the audio, silence or trim.',
    );
    const replace: Recipe = { ...DEFAULT_RECIPE, audio: 'replace', trackId: 'song' };
    expect(() => queue.start(replace, BESIDE, null)).toThrow('Choose the replacement audio.');
    const gone = { path: path.resolve('gone', 'song.mp3'), suffix: 'song' };
    expect(() => queue.start(replace, BESIDE, gone)).toThrow(
      'song.mp3 is missing: it was moved or deleted.',
    );
    expect(kinds(queue.list())).toEqual(['ready', 'ready', 'ready']);
  });

  it('gives the jobs the replacement soundtrack, with its suffix, when the audio is replaced', async () => {
    const runs = controlRuns();
    const { queue, until } = await readyQueue();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'video-tool-track-'));
    try {
      const track = { path: path.join(dir, 'Beach waves.mp3'), suffix: 'Plage 🌊' };
      await writeFile(track.path, '');
      const replace: Recipe = { ...DEFAULT_RECIPE, audio: 'replace', trackId: 'song' };
      expect(queue.start(replace, BESIDE, track)).toBe(3);
      await until(() => runs.length === 1);
      expect(runs[0]?.input.track).toEqual(track);
      // A soundtrack given with a recipe that does not replace the audio is not used.
      queue.cancel(null);
      await until(() => !queue.busy());
      queue.reset(queue.list().map((item) => item.id));
      queue.start(REMOVE_AUDIO, BESIDE, track);
      await until(() => runs.length === 2);
      expect(runs[1]?.input.track).toBeNull();
      queue.cancel(null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('processes one video at a time, in list order', async () => {
    const runs = controlRuns();
    const { queue, changes, until } = await readyQueue();
    expect(queue.start(REMOVE_AUDIO, BESIDE, null)).toBe(3);
    expect(kinds(queue.list())).toEqual(['running', 'queued', 'queued']);
    expect(queue.busy()).toBe(true);
    for (const [index, file] of files.entries()) {
      await until(() => runs.length === index + 1);
      expect(runs[index]?.input).toMatchObject({ source: file, recipe: REMOVE_AUDIO });
      runs[index]?.finish(`${file}.out.mp4`);
      await until((items) => items[index]?.state.kind === 'done');
    }
    expect(queue.list().map((item) => item.state)).toEqual(
      files.map((file) => ({ kind: 'done', outputPath: `${file}.out.mp4` })),
    );
    expect(
      changes.every((items) => kinds(items).filter((kind) => kind === 'running').length <= 1),
    ).toBe(true);
    expect(queue.busy()).toBe(false);
    const [first] = queue.list();
    expect(queue.outputPath(first!.id)).toBe(`${files[0]!}.out.mp4`);
    expect(queue.sourcePath(first!.id)).toBe(files[0]);
    expect(queue.outputPath('unknown')).toBeNull();
  });

  it('fails at once the videos the recipe cannot apply to', async () => {
    const { queue } = await readyQueue();
    const tooLong: Recipe = { ...REMOVE_AUDIO, trimStart: { amount: 5, unit: 'seconds' } };
    expect(queue.start(tooLong, BESIDE, null)).toBe(0);
    expect(queue.list()[0]?.state).toEqual({
      kind: 'failed',
      message: 'The trims remove all of it (0:03 long).',
    });
    expect(processVideo).not.toHaveBeenCalled();
  });

  it('reports failures with their message', async () => {
    const runs = controlRuns();
    const { queue, until } = await readyQueue();
    queue.start(REMOVE_AUDIO, BESIDE, null);
    const failures = [
      new JobError('The output folder /x does not exist.'),
      new FfmpegError('ffmpeg failed: No space left on device.'),
      new Error('Boom'),
    ];
    for (const [index, error] of failures.entries()) {
      await until(() => runs.length === index + 1);
      runs[index]?.fail(error);
    }
    const items = await until((list) => list.every((item) => item.state.kind === 'failed'));
    expect(items.map((item) => item.state)).toEqual([
      { kind: 'failed', message: 'The output folder /x does not exist.' },
      { kind: 'failed', message: 'ffmpeg failed: No space left on device.' },
      { kind: 'failed', message: 'Something went wrong: Boom' },
    ]);
  });

  it('cancels queued videos at once, the running one once ffmpeg has stopped', async () => {
    const runs = controlRuns();
    const { queue, until } = await readyQueue();
    queue.start(REMOVE_AUDIO, BESIDE, null);
    const [first, second] = queue.list();
    queue.cancel([second!.id]);
    expect(kinds(queue.list())).toEqual(['running', 'canceled', 'queued']);
    queue.cancel(null);
    expect(kinds(queue.list())).toEqual(['running', 'canceled', 'canceled']);
    expect(runs[0]?.input.signal.aborted).toBe(true);
    await until((items) => items[0]?.state.kind === 'canceled');
    expect(runs).toHaveLength(1);
    expect(queue.busy()).toBe(false);
    // Canceled videos are processed again by the next start, in list order.
    expect(queue.start(REMOVE_AUDIO, BESIDE, null)).toBe(3);
    await until(() => runs.length === 2);
    expect(runs[1]?.input.source).toBe(first!.path);
  });

  it('removes a running video after stopping it, then goes on', async () => {
    const runs = controlRuns();
    const { queue, until } = await readyQueue();
    queue.start(REMOVE_AUDIO, BESIDE, null);
    const [first] = queue.list();
    queue.remove([first!.id]);
    expect(queue.list().map((item) => item.name)).toEqual(['b.mp4', 'c.mp4']);
    expect(runs[0]?.input.signal.aborted).toBe(true);
    await until(() => runs.length === 2);
    expect(runs[1]?.input.source).toBe(files[1]);
    expect(queue.sourcePath(first!.id)).toBeNull();
  });

  it('adds videos queued during a run to its end, with their own recipe', async () => {
    const runs = controlRuns();
    const { queue, until } = await readyQueue();
    queue.start(REMOVE_AUDIO, BESIDE, null);
    vi.mocked(probeVideo).mockImplementation((_, file) => Promise.resolve(fakeProbe(file)));
    const late = path.resolve('videos', 'late.mp4');
    queue.add([late]);
    await until((items) => items[3]?.state.kind === 'ready');
    const trim: Recipe = {
      ...DEFAULT_RECIPE,
      audio: 'keep',
      trimEnd: { amount: 1, unit: 'seconds' },
    };
    expect(queue.start(trim, BESIDE, null)).toBe(1);
    for (let index = 0; index < 4; index++) {
      await until(() => runs.length === index + 1);
      runs[index]?.finish(`out-${String(index)}.mp4`);
    }
    expect(runs.map((run) => path.basename(run.input.source))).toEqual([
      'a.mp4',
      'b.mp4',
      'c.mp4',
      'late.mp4',
    ]);
    expect(runs[3]?.input.recipe).toBe(trim);
    expect(runs[2]?.input.recipe).toBe(REMOVE_AUDIO);
  });

  it('resets finished videos and clears them', async () => {
    const runs = controlRuns();
    const { queue, until } = await readyQueue();
    queue.start(REMOVE_AUDIO, BESIDE, null);
    await until(() => runs.length === 1);
    runs[0]?.finish('out.mp4');
    await until(() => runs.length === 2);
    runs[1]?.fail(new JobError('Nope.'));
    await until(() => runs.length === 3);
    const ids = queue.list().map((item) => item.id);
    queue.reset(ids);
    expect(kinds(queue.list())).toEqual(['ready', 'ready', 'running']);
    runs[2]?.finish('out-2.mp4');
    await until((items) => items[2]?.state.kind === 'done');
    queue.clear('finished');
    expect(queue.list().map((item) => item.name)).toEqual(['a.mp4', 'b.mp4']);
    queue.clear('all');
    expect(queue.list()).toEqual([]);
  });

  it('coalesces the results of probing a whole folder into a few emissions', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.mocked(probeVideo).mockImplementation((_, file) => Promise.resolve(fakeProbe(file)));
    const { queue, changes } = createQueue(FAKE_TOOLS);
    const many = Array.from({ length: 1000 }, (_, index) => path.resolve('videos', `${index}.mp4`));
    queue.add(many);
    // Adding is the user's: at once.
    expect(changes).toHaveLength(1);
    for (
      let step = 0;
      step < 100 && !queue.list().every(({ state }) => state.kind === 'ready');
      step++
    ) {
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(200);
    expect(kinds(changes.at(-1) ?? [])).toEqual(Array<string>(1000).fill('ready'));
    expect(changes.length).toBeLessThanOrEqual(10);
  });

  it('coalesces runs that fail one after the other', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.mocked(probeVideo).mockImplementation((_, file) => Promise.resolve(fakeProbe(file)));
    vi.mocked(processVideo).mockRejectedValue(new JobError('The output folder /x does not exist.'));
    const { queue, changes } = createQueue(FAKE_TOOLS);
    queue.add(Array.from({ length: 1000 }, (_, index) => path.resolve('videos', `${index}.mp4`)));
    for (
      let step = 0;
      step < 100 && queue.list().some(({ state }) => state.kind !== 'ready');
      step++
    ) {
      await vi.advanceTimersByTimeAsync(10);
    }
    const before = changes.length;
    expect(queue.start(REMOVE_AUDIO, BESIDE, null)).toBe(1000);
    for (let step = 0; step < 100 && queue.busy(); step++) {
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(200);
    expect(kinds(changes.at(-1) ?? [])).toEqual(Array<string>(1000).fill('failed'));
    expect(changes.length - before).toBeLessThanOrEqual(10);
  });

  it('emits progress and finished runs at most five times a second, what the user does at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const runs = controlRuns();
    vi.mocked(probeVideo).mockImplementation((_, file) => Promise.resolve(fakeProbe(file)));
    const { queue, changes } = createQueue(FAKE_TOOLS);
    queue.add(files.slice(0, 1));
    await vi.advanceTimersByTimeAsync(0);
    queue.start(REMOVE_AUDIO, BESIDE, null);
    // Queued at once; running with the next emission.
    expect(kinds(changes.at(-1) ?? [])).toEqual(['queued']);
    await vi.advanceTimersByTimeAsync(200);
    expect(kinds(changes.at(-1) ?? [])).toEqual(['running']);
    const before = changes.length;
    const report = (progress: number) => {
      runs[0]?.input.onProgress({ progress, speed: 2 });
    };
    vi.advanceTimersByTime(500);
    for (let step = 1; step <= 10; step++) {
      report(step / 100);
    }
    expect(changes.length - before).toBe(1);
    expect(changes.at(-1)?.[0]?.state).toEqual({ kind: 'running', progress: 0.01, speed: 2 });
    vi.advanceTimersByTime(199);
    expect(changes.length - before).toBe(1);
    vi.advanceTimersByTime(1);
    expect(changes.length - before).toBe(2);
    expect(changes.at(-1)?.[0]?.state).toEqual({ kind: 'running', progress: 0.1, speed: 2 });
    report(0.2);
    runs[0]?.finish('out.mp4');
    await vi.advanceTimersByTimeAsync(0);
    // With the progress that was waiting.
    expect(changes.length - before).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(changes.length - before).toBe(3);
    expect(changes.at(-1)?.[0]?.state).toEqual({ kind: 'done', outputPath: 'out.mp4' });
    // Resetting is the user's: at once.
    const emitted = changes.length;
    queue.reset([queue.list()[0]!.id]);
    expect(changes).toHaveLength(emitted + 1);
  });

  it('aborts the run synchronously when the app is about to end, starting nothing else', async () => {
    const runs = controlRuns();
    const { queue } = await readyQueue();
    const undo = vi.fn();
    vi.mocked(processVideo).mockImplementation((input) => {
      input.onAbortNow?.(undo);
      return new Promise<string>((_, reject) => {
        input.signal.addEventListener('abort', () => {
          reject(new CanceledError());
        });
        runs.push({ input, finish: () => undefined, fail: reject });
      });
    });
    queue.start(REMOVE_AUDIO, BESIDE, null);
    queue.abortNow();
    expect(undo).toHaveBeenCalledOnce();
    expect(runs[0]?.input.signal.aborted).toBe(true);
    // States are left as they are: the process ends now.
    expect(kinds(queue.list())).toEqual(['running', 'queued', 'queued']);
    await settle();
    await settle();
    expect(runs).toHaveLength(1);
    expect(processVideo).toHaveBeenCalledOnce();
    // Without a run, nothing to do.
    expect(() => {
      createQueue(FAKE_TOOLS).queue.abortNow();
    }).not.toThrow();
  });

  it('cancels everything on dispose, and waits for the run to stop', async () => {
    const runs = controlRuns();
    const { queue } = await readyQueue();
    queue.start(REMOVE_AUDIO, BESIDE, null);
    await queue.dispose();
    expect(runs[0]?.input.signal.aborted).toBe(true);
    expect(kinds(queue.list())).toEqual(['canceled', 'canceled', 'canceled']);
    expect(runs).toHaveLength(1);
  });
});

describe.skipIf(ffmpegMissing)('Queue with ffmpeg', () => {
  let dir: string;
  const file = (name: string) => path.join(dir, name);
  const partials = async () => (await readdir(dir)).filter((name) => name.includes('.partial-'));

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'video-tool-queue-'));
    await Promise.all([
      ffmpeg([
        ...['-loglevel', 'error', '-f', 'lavfi', '-i', rampSource(1, 30, '160x120')],
        ...['-f', 'lavfi', '-i', toneSource(1), '-c:v', 'libx264', '-c:a', 'aac', file('clip.mp4')],
      ]),
      ffmpeg([
        ...['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=20'],
        ...['-c:v', 'libx264', '-preset', 'ultrafast', file('slow.mp4')],
      ]),
      writeFile(file('notes.mp4'), 'not a video'),
    ]);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('probes and processes real videos', async () => {
    const { queue, until } = createQueue(requireTools());
    queue.add([file('clip.mp4'), file('notes.mp4')]);
    const probed = await until((items) => items.every((item) => item.state.kind !== 'probing'));
    expect(probed[0]?.info).toMatchObject({
      width: 160,
      height: 120,
      frameRate: 30,
      frameCount: 30,
    });
    expect(probed[1]?.state).toEqual({
      kind: 'unsupported',
      message: 'This file cannot be read: it may be damaged, or not a video.',
    });
    expect(queue.start(REMOVE_AUDIO, BESIDE, null)).toBe(1);
    const [done] = await until((items) => items[0]?.state.kind === 'done');
    expect(done?.state).toEqual({ kind: 'done', outputPath: file('clip (no audio).mp4') });
    await queue.dispose();
  });

  it('cancels a running ffmpeg and deletes its partial file', async () => {
    const { queue, until } = createQueue(requireTools());
    queue.add([file('slow.mp4')]);
    await until((items) => items[0]?.state.kind === 'ready');
    queue.start({ ...REMOVE_AUDIO, trimStart: { amount: 1, unit: 'frames' } }, BESIDE, null);
    await until((items) => {
      const state = items[0]?.state;
      return state?.kind === 'running' && state.progress !== null;
    });
    expect(await partials()).toHaveLength(1);
    queue.cancel(null);
    await until((items) => items[0]?.state.kind === 'canceled');
    expect(await partials()).toEqual([]);
  });

  it('kills ffmpeg and deletes its partial file before abortNow returns', async () => {
    const { queue, until } = createQueue(requireTools());
    queue.add([file('slow.mp4')]);
    await until((items) => items[0]?.state.kind === 'ready');
    queue.start({ ...REMOVE_AUDIO, trimStart: { amount: 1, unit: 'frames' } }, BESIDE, null);
    await until((items) => {
      const state = items[0]?.state;
      return state?.kind === 'running' && state.progress !== null;
    });
    expect(await partials()).toHaveLength(1);
    queue.abortNow();
    // Synchronously: nothing asynchronous runs once Windows ends the session.
    expect(readdirSync(dir).filter((name) => name.includes('.partial-'))).toEqual([]);
    await until((items) => items[0]?.state.kind === 'canceled');
  });

  it('waits for ffmpeg to exit on dispose', async () => {
    const { queue, until } = createQueue(requireTools());
    queue.add([file('slow.mp4')]);
    await until((items) => items[0]?.state.kind === 'ready');
    queue.start({ ...REMOVE_AUDIO, trimStart: { amount: 1, unit: 'frames' } }, BESIDE, null);
    await until((items) => items[0]?.state.kind === 'running');
    await queue.dispose();
    expect(queue.list()[0]?.state.kind).toBe('canceled');
    expect(await partials()).toEqual([]);
  });
});
