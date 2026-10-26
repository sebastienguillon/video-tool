import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { constants, setPriority } from 'node:os';
import path from 'node:path';

/** Options every job gets: no prompts, quiet stderr (errors only), machine-readable progress on stdout. */
const GLOBAL_ARGS = [
  ...['-hide_banner', '-nostdin', '-y', '-loglevel', 'error'],
  ...['-progress', 'pipe:1', '-nostats'],
];

/** Lines of stderr kept for the error message. */
const STDERR_LINES = 50;
const MAX_MESSAGE = 300;
/** After a polite SIGTERM (macOS, Linux), or taskkill (Windows), how long before SIGKILL. */
const KILL_DELAY_MS = 3000;
/** How long `taskkill` may block when the app is about to exit. */
const TASKKILL_TIMEOUT_MS = 5000;

export interface Progress {
  /** 0 to 1; `null` until ffmpeg reports a position. */
  readonly progress: number | null;
  /** Times real time; `null` until ffmpeg reports it. */
  readonly speed: number | null;
}

export interface RunOptions {
  /** Expected length of the result, to turn positions into a fraction. */
  readonly durationSec: number;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: Progress) => void;
  /**
   * Given a function that kills ffmpeg at once, blocking until it is gone, while it runs; then
   * `null`. For when the app is about to exit without waiting (see `Queue.abortNow`).
   */
  readonly onKillNow?: (killNow: (() => void) | null) => void;
}

/** ffmpeg failed; `message` is short enough to show. */
export class FfmpegError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FfmpegError';
  }
}

/** The run was aborted through its signal. */
export class CanceledError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'CanceledError';
  }
}

export interface RunResult {
  /** Video frames written, as ffmpeg last reported; `0` when the cuts left nothing. */
  readonly frames: number | null;
}

/**
 * Runs one ffmpeg job. Resolves once the process has exited and closed its files (on Windows a
 * file stays locked until then), so the caller may rename or delete the output right away.
 */
export function runFfmpeg(
  ffmpeg: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  const { signal } = options;
  if (signal.aborted) {
    return Promise.reject(new CanceledError());
  }
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [...GLOBAL_ARGS, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (child.pid !== undefined) {
      try {
        // Encoding takes every core: the rest of the desktop goes first. A launcher (a Chocolatey
        // shim) passes it on: Windows starts the real ffmpeg, a moment later, at its priority.
        setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // Not allowed here: it runs at normal priority.
      }
      options.onKillNow?.(() => {
        stopProcess(child, { now: true });
      });
    }
    const parser = new ProgressParser();
    const stderr = new LineTail(STDERR_LINES);
    let spawnError: Error | null = null;
    let frames: number | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const abort = (): void => {
      stopProcess(child, { now: false });
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_DELAY_MS);
    };
    signal.addEventListener('abort', abort, { once: true });
    const settle = (error: Error | null): void => {
      clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
      options.onKillNow?.(null);
      if (error === null) {
        resolve({ frames });
      } else {
        reject(error);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const report of parser.push(chunk)) {
        frames = report.frames ?? frames;
        options.onProgress(toProgress(report, options.durationSec));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr.push(chunk);
    });
    child.on('error', (error) => {
      spawnError = error;
      if (child.pid === undefined) {
        // Never started: no 'close' to wait for, nothing written.
        settle(new FfmpegError(`Cannot run ffmpeg: ${error.message}`));
      }
    });
    // 'close' comes after 'exit', once the pipes are closed too.
    child.on('close', (code, exitSignal) => {
      if (child.pid === undefined) {
        return;
      }
      if (signal.aborted) {
        settle(new CanceledError());
      } else if (spawnError !== null) {
        settle(new FfmpegError(`ffmpeg failed: ${spawnError.message}`));
      } else if (code === 0) {
        settle(null);
      } else {
        const detail = errorSummary(stderr.text());
        settle(
          new FfmpegError(
            detail === null
              ? `ffmpeg stopped unexpectedly (${exitSignal ?? `code ${String(code)}`}).`
              : `ffmpeg failed: ${detail}`,
          ),
        );
      }
    });
  });
}

const TASKKILL = path.win32.join(
  process.env['SystemRoot'] ?? 'C:\\Windows',
  'System32',
  'taskkill.exe',
);

/**
 * Runs `taskkill` with `args`, blocking until it exits when `now`; calls `failed` when it could not
 * run or did not succeed. Replaced in tests.
 */
export type TaskKill = (args: readonly string[], now: boolean, failed: () => void) => void;

const runTaskKill: TaskKill = (args, now, failed) => {
  const options = { windowsHide: true, stdio: 'ignore' } as const;
  if (now) {
    const result = spawnSync(TASKKILL, args, { ...options, timeout: TASKKILL_TIMEOUT_MS });
    if (result.error !== undefined || result.status !== 0) {
      failed();
    }
    return;
  }
  spawn(TASKKILL, args, options)
    .on('error', failed)
    .on('exit', (code) => {
      if (code !== 0) {
        failed();
      }
    });
};

export interface StopOptions {
  /** The app is about to exit: kill at once, and block until the processes are gone. */
  readonly now: boolean;
  /** Replaced in tests. */
  readonly platform?: NodeJS.Platform;
  readonly taskKill?: TaskKill;
}

/**
 * Stops ffmpeg, and on Windows whatever it started. There, `kill` ends that one process: a launcher
 * such as a Chocolatey shim would die and leave the real ffmpeg running, still writing and holding
 * the pipes open, so the run would never settle. `taskkill /T` ends the whole tree, which it finds
 * through the launcher: nothing may kill the launcher before it. `kill` remains the fallback.
 * Elsewhere ffmpeg gets SIGTERM, to stop cleanly, or SIGKILL when the app is about to exit.
 */
export function stopProcess(child: Pick<ChildProcess, 'pid' | 'kill'>, options: StopOptions): void {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' || child.pid === undefined) {
    child.kill(options.now ? 'SIGKILL' : 'SIGTERM');
    return;
  }
  (options.taskKill ?? runTaskKill)(['/pid', String(child.pid), '/T', '/F'], options.now, () => {
    child.kill();
  });
}

function toProgress(report: ProgressReport, durationSec: number): Progress {
  const position = report.done ? durationSec : report.outTimeSec;
  return {
    progress:
      position === null || durationSec <= 0
        ? null
        : Math.min(1, Math.max(0, position / durationSec)),
    speed: report.speed,
  };
}

/** One block of `-progress` output, which ends with a `progress=` line. */
export interface ProgressReport {
  /** Position in the output; `null` while ffmpeg has none (`N/A`, or negative at the start). */
  readonly outTimeSec: number | null;
  readonly speed: number | null;
  /** Video frames written so far. */
  readonly frames: number | null;
  /** `progress=end`: the last report. */
  readonly done: boolean;
}

/** Reads ffmpeg's `-progress` stream: `key=value` lines, in blocks, split anywhere between chunks. */
export class ProgressParser {
  private pending = '';
  private values = new Map<string, string>();

  /** Feeds a chunk of stdout; returns the blocks it completed. */
  push(chunk: string): ProgressReport[] {
    const lines = (this.pending + chunk).split(/\r?\n/);
    this.pending = lines.pop() ?? '';
    const reports: ProgressReport[] = [];
    for (const line of lines) {
      const separator = line.indexOf('=');
      if (separator === -1) {
        continue;
      }
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (key !== 'progress') {
        this.values.set(key, value);
        continue;
      }
      reports.push({
        outTimeSec: outTime(this.values),
        speed: speedOf(this.values.get('speed')),
        frames: frameCount(this.values.get('frame')),
        done: value === 'end',
      });
      this.values = new Map();
    }
    return reports;
  }
}

/** `out_time_us`, or `out_time_ms` (microseconds too, despite its name), or `out_time` (a clock). */
function outTime(values: ReadonlyMap<string, string>): number | null {
  for (const key of ['out_time_us', 'out_time_ms']) {
    const micros = Number(values.get(key) ?? Number.NaN);
    if (Number.isFinite(micros)) {
      return micros >= 0 ? micros / 1_000_000 : null;
    }
  }
  const clock = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(values.get('out_time') ?? '');
  if (!clock) {
    return null;
  }
  const [, hours = '0', minutes = '0', seconds = '0'] = clock;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function frameCount(value: string | undefined): number | null {
  const count = value === undefined || value === '' ? Number.NaN : Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/** `1.5x`; `N/A` until known. */
function speedOf(value: string | undefined): number | null {
  const match = /^(\d+(?:\.\d+)?(?:e[+-]?\d+)?)x$/i.exec(value ?? '');
  const speed = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  return Number.isFinite(speed) && speed > 0 ? speed : null;
}

/** ffmpeg's follow-ups to the error that matters, which say nothing more. */
const BOILERPLATE = [
  /^Conversion failed!?$/i,
  /^Task finished with error code/i,
  /^Terminating thread with return code/i,
  /^Error sending frames to consumers/i,
  /^Nothing was written into output file/i,
  /^Could not open encoder before EOF/i,
  /^Error while filtering:/i,
  /^Error opening output files?:/i,
  /^Error opening input files?:/i,
  /^Error (opening input|opening output) file /i,
  // Banners some encoders print whatever the log level.
  /^Svt\[(info|warn)\]/,
  /^x26[45] \[(info|warning)\]/,
];

/**
 * A short message from what ffmpeg wrote to stderr: its own lines, without the `[component @
 * 0x…]` prefixes nor the generic follow-ups, root cause first. `null` when there is nothing to say.
 */
export function errorSummary(stderr: string): string | null {
  const lines: string[] = [];
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.replace(/^(\s*\[[^\]]*\]\s*)+/, '').trim();
    if (
      line !== '' &&
      !BOILERPLATE.some((pattern) => pattern.test(line)) &&
      !lines.includes(line)
    ) {
      lines.push(line);
    }
  }
  const [first, ...rest] = lines.map((line) => (/[.!?:]$/.test(line) ? line : `${line}.`));
  if (first === undefined) {
    return null;
  }
  let message = first;
  for (const sentence of rest) {
    if (message.length + 1 + sentence.length > MAX_MESSAGE) {
      break;
    }
    message = `${message} ${sentence}`;
  }
  if (message.length > MAX_MESSAGE) {
    message = `${message.slice(0, MAX_MESSAGE - 1).trimEnd()}…`;
  }
  return message.charAt(0).toUpperCase() + message.slice(1);
}

/** The last lines of a stream, without keeping it all in memory. */
class LineTail {
  private readonly limit: number;
  private lines: string[] = [];
  private partial = '';

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    this.lines.push(...parts);
    if (this.lines.length > this.limit) {
      this.lines = this.lines.slice(-this.limit);
    }
  }

  text(): string {
    return [...this.lines, this.partial].join('\n');
  }
}
