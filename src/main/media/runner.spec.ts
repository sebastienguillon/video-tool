import { existsSync, readdirSync, rmSync } from 'node:fs';
import { copyFile, link, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Progress, TaskKill } from './runner';
import {
  CanceledError,
  errorSummary,
  FfmpegError,
  ProgressParser,
  runFfmpeg,
  stopProcess,
} from './runner';
import { ffmpegMissing, requireTools } from './testing/fixtures';

const BLOCK = [
  'frame=45',
  'fps=0.00',
  'stream_0_0_q=-1.0',
  'bitrate=N/A',
  'total_size=1234',
  'out_time_us=1500000',
  'out_time_ms=1500000',
  'out_time=00:00:01.500000',
  'dup_frames=0',
  'drop_frames=0',
  'speed=1.52x',
  'progress=continue',
  '',
].join('\n');

describe('ProgressParser', () => {
  it('reports each block, however the chunks split it', () => {
    const parser = new ProgressParser();
    const text = `${BLOCK}${BLOCK.replace('progress=continue', 'progress=end')}`;
    const reports = [];
    for (let index = 0; index < text.length; index += 7) {
      reports.push(...parser.push(text.slice(index, index + 7)));
    }
    expect(reports).toEqual([
      { outTimeSec: 1.5, speed: 1.52, frames: 45, done: false },
      { outTimeSec: 1.5, speed: 1.52, frames: 45, done: true },
    ]);
  });

  it('reads out_time_ms as microseconds, and the clock as a last resort', () => {
    const parser = new ProgressParser();
    expect(parser.push('out_time_ms=2500000\r\nprogress=continue\r\n')).toMatchObject([
      { outTimeSec: 2.5 },
    ]);
    expect(parser.push('out_time=01:02:03.250000\nprogress=continue\n')).toMatchObject([
      { outTimeSec: 3723.25 },
    ]);
  });

  it('reports unknowns as null', () => {
    const parser = new ProgressParser();
    const unknown = 'frame=N/A\nout_time_us=N/A\nout_time=N/A\nspeed=N/A\nprogress=continue\n';
    expect(parser.push(unknown)).toEqual([
      { outTimeSec: null, speed: null, frames: null, done: false },
    ]);
    expect(
      parser.push('out_time_us=-9223372036854775807\nspeed=   0x\nprogress=continue\n'),
    ).toEqual([{ outTimeSec: null, speed: null, frames: null, done: false }]);
  });
});

describe('errorSummary', () => {
  it('keeps the cause, without component prefixes and generic follow-ups', () => {
    const stderr = [
      '[mov,mp4,m4a,3gp,3g2,mj2 @ 000001d6531fcf80] moov atom not found',
      '[in#0 @ 000001d6531fcf80] Error opening input: Invalid data found when processing input',
      'Error opening input file C:\\videos\\clip.mp4.',
      'Error opening input files: Invalid data found when processing input',
    ].join('\r\n');
    expect(errorSummary(stderr)).toBe(
      'Moov atom not found. Error opening input: Invalid data found when processing input.',
    );
  });

  it('drops encoder banners and thread noise', () => {
    const stderr = [
      'Svt[info]: -------------------------------------------',
      '[libopus @ 0x55] Invalid channel layout 5.1(side) for specified mapping family -1.',
      '[aost#0:0/libopus @ 0x56] Error while opening encoder - maybe incorrect parameters',
      '[af#0:0 @ 0x57] Task finished with error code: -22 (Invalid argument)',
      '[af#0:0 @ 0x57] Terminating thread with return code -22 (Invalid argument)',
      '[out#0/webm @ 0x58] Nothing was written into output file, because at least one stream received no packets.',
      'Conversion failed!',
    ].join('\n');
    expect(errorSummary(stderr)).toBe(
      'Invalid channel layout 5.1(side) for specified mapping family -1. Error while opening encoder - maybe incorrect parameters.',
    );
  });

  it('stays short, and says nothing when there is nothing', () => {
    expect(errorSummary(`${'x'.repeat(500)}\nsecond line`)).toHaveLength(300);
    expect(errorSummary(`${'a'.repeat(200)}\n${'b'.repeat(200)}`)).toBe(`A${'a'.repeat(199)}.`);
    expect(errorSummary('\n  \nConversion failed!\n')).toBeNull();
  });
});

describe('stopProcess', () => {
  const child = () => ({ pid: 1234, kill: vi.fn(() => true) });

  it('kills the whole process tree on Windows, before anything kills the launcher', () => {
    const process = child();
    const taskKill = vi.fn<TaskKill>();
    stopProcess(process, { now: false, platform: 'win32', taskKill });
    expect(taskKill).toHaveBeenCalledWith(
      ['/pid', '1234', '/T', '/F'],
      false,
      expect.any(Function),
    );
    expect(process.kill).not.toHaveBeenCalled();
    stopProcess(process, { now: true, platform: 'win32', taskKill });
    expect(taskKill).toHaveBeenLastCalledWith(
      ['/pid', '1234', '/T', '/F'],
      true,
      expect.any(Function),
    );
  });

  it('falls back on killing the process itself when taskkill fails', () => {
    const process = child();
    stopProcess(process, {
      now: false,
      platform: 'win32',
      taskKill: (_, __, failed) => {
        failed();
      },
    });
    expect(process.kill).toHaveBeenCalledWith();
  });

  it('sends SIGTERM elsewhere, SIGKILL when the app is about to exit', () => {
    const process = child();
    const taskKill = vi.fn<TaskKill>();
    stopProcess(process, { now: false, platform: 'linux', taskKill });
    expect(process.kill).toHaveBeenLastCalledWith('SIGTERM');
    stopProcess(process, { now: true, platform: 'darwin', taskKill });
    expect(process.kill).toHaveBeenLastCalledWith('SIGKILL');
    expect(taskKill).not.toHaveBeenCalled();
  });
});

describe.skipIf(ffmpegMissing)('runFfmpeg', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'video-tool-runner-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const generate = (seconds: number, output: string) => [
    ...['-f', 'lavfi', '-i', `testsrc2=s=320x240:r=30:d=${seconds}`],
    ...['-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'mp4', output],
  ];

  it('runs to the end, reporting progress', async () => {
    const output = path.join(dir, 'done.mp4');
    const reports: Progress[] = [];
    const result = await runFfmpeg(requireTools().ffmpeg, generate(2, output), {
      durationSec: 2,
      signal: new AbortController().signal,
      onProgress: (progress) => reports.push(progress),
    });
    expect(result.frames).toBe(60);
    expect(reports.at(-1)).toMatchObject({ progress: 1 });
    expect((await stat(output)).size).toBeGreaterThan(0);
  });

  it('fails with what ffmpeg says', async () => {
    const run = runFfmpeg(
      requireTools().ffmpeg,
      ['-i', path.join(dir, 'missing.mp4'), '-f', 'null', '-'],
      {
        durationSec: 1,
        signal: new AbortController().signal,
        onProgress: () => undefined,
      },
    );
    await expect(run).rejects.toThrow(FfmpegError);
    // Since ffmpeg 7.0, it says which step failed; before, which file.
    await expect(run).rejects.toThrow(
      /^ffmpeg failed: (Error opening input|.*missing\.mp4): No such file or directory/,
    );
  });

  it('stops when aborted, once the process has exited', async () => {
    const controller = new AbortController();
    const run = runFfmpeg(requireTools().ffmpeg, generate(600, path.join(dir, 'long.mp4')), {
      durationSec: 600,
      signal: controller.signal,
      onProgress: () => {
        controller.abort();
      },
    });
    await expect(run).rejects.toThrow(CanceledError);
    await expect(
      runFfmpeg(requireTools().ffmpeg, [], {
        durationSec: 1,
        signal: controller.signal,
        onProgress: () => undefined,
      }),
    ).rejects.toThrow(CanceledError);
  });

  it('kills ffmpeg synchronously when asked to, for an app about to exit', async () => {
    const output = path.join(dir, 'killed.mp4');
    const handle: { killNow: (() => void) | null } = { killNow: null };
    const started = Promise.withResolvers<undefined>();
    const run = runFfmpeg(requireTools().ffmpeg, generate(600, output), {
      durationSec: 600,
      signal: new AbortController().signal,
      onProgress: () => {
        started.resolve(undefined);
      },
      onKillNow: (kill) => {
        handle.killNow = kill;
      },
    });
    await started.promise;
    expect(handle.killNow).toBeTypeOf('function');
    handle.killNow?.();
    // Gone before anything asynchronous runs: its file can be deleted at once.
    rmSync(output, { force: true, maxRetries: 10, retryDelay: 50 });
    expect(existsSync(output)).toBe(false);
    await expect(run).rejects.toThrow(FfmpegError);
    expect(handle.killNow).toBeNull();
  });

  // Chocolatey installs ffmpeg as a shim, which starts the real one and waits for it.
  const shim = 'C:\\ProgramData\\chocolatey\\redirects\\choco.exe';
  it.skipIf(process.platform !== 'win32' || !existsSync(shim))(
    'stops ffmpeg started through a launcher, which a kill of the launcher alone leaves running',
    async () => {
      // The shim starts `..\choco.exe`, relative to itself: there, a copy of ffmpeg.
      const shimDir = path.join(dir, 'shim', 'bin');
      await mkdir(shimDir, { recursive: true });
      await copyFile(shim, path.join(shimDir, 'ffmpeg.exe'));
      const target = path.join(dir, 'shim', 'choco.exe');
      await link(requireTools().ffmpeg, target).catch(() =>
        copyFile(requireTools().ffmpeg, target),
      );
      const controller = new AbortController();
      const output = path.join(dir, 'shimmed.mp4');
      // An encode that takes minutes: only a stopped ffmpeg lets the run settle in seconds.
      const args = [
        ...['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=600', '-c:v', 'libx264'],
        ...['-preset', 'medium', '-f', 'mp4', output],
      ];
      const begun = Date.now();
      await expect(
        runFfmpeg(path.join(shimDir, 'ffmpeg.exe'), args, {
          durationSec: 600,
          signal: controller.signal,
          onProgress: () => {
            controller.abort();
          },
        }),
      ).rejects.toThrow(CanceledError);
      expect(Date.now() - begun).toBeLessThan(20_000);
      // Its file is free once Windows releases it, a moment after the exit (`removeFile` retries
      // likewise).
      await rm(output, { force: true, maxRetries: 10, retryDelay: 100 });
      expect(readdirSync(dir)).not.toContain('shimmed.mp4');
    },
    30_000,
  );

  it('fails when ffmpeg cannot start', async () => {
    await expect(
      runFfmpeg(path.join(dir, 'no-ffmpeg-here'), [], {
        durationSec: 1,
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    ).rejects.toThrow(/^Cannot run ffmpeg: /);
  });
});
