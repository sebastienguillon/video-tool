import { computed, inject, Injectable, signal } from '@angular/core';
import { createLogger } from '@shared/log';
import type { Environment } from '@shared/model';
import { MIN_FFMPEG_VERSION } from '@shared/model';
import { DESKTOP } from './desktop';

const log = createLogger('environment');

/** Startup never waits longer than this to know whether ffmpeg is there. */
const LOAD_TIMEOUT_MS = 2_000;

const INSTALL_COMMANDS: Readonly<Record<string, string>> = {
  darwin: 'brew install ffmpeg',
  win32: 'winget install Gyan.FFmpeg',
};

/**
 * Commands that bring ffmpeg up to date. winget's install upgrades a package it installed, and
 * installs it otherwise. Linux has none: a distribution keeps the version it shipped with.
 */
const UPDATE_COMMANDS: Readonly<Record<string, string>> = {
  darwin: 'brew upgrade ffmpeg',
  win32: 'winget install Gyan.FFmpeg',
};

/** What the main process found on this computer: the app version, and ffmpeg. */
@Injectable({ providedIn: 'root' })
export class EnvironmentStore {
  private readonly desktop = inject(DESKTOP);

  /** `null` until known. */
  readonly environment = signal<Environment | null>(null);
  /** Known to be missing: nothing can be processed. */
  readonly ffmpegMissing = computed(() => this.environment()?.ffmpeg === null);
  /**
   * The version of the ffmpeg found when it is too old to process anything, as short as it tells
   * (`4.2.7`, not `4.2.7-0ubuntu0.1`); `null` otherwise.
   */
  readonly outdatedVersion = computed(() => {
    const ffmpeg = this.environment()?.ffmpeg;
    return ffmpeg?.supported === false ? shortVersion(ffmpeg.version) : null;
  });
  /** The oldest ffmpeg that Video Tool is known to work with. */
  readonly minVersion = MIN_FFMPEG_VERSION;
  /** The command that installs ffmpeg on this platform. */
  readonly installCommand = INSTALL_COMMANDS[this.desktop.platform] ?? 'sudo apt install ffmpeg';
  /** The command that updates ffmpeg on this platform; `null` when there is none to give. */
  readonly updateCommand = UPDATE_COMMANDS[this.desktop.platform] ?? null;

  /**
   * Used as an app initializer, so that the warning about ffmpeg is there from the start. An answer
   * slower than the startup allows still arrives.
   */
  async load(): Promise<void> {
    const loading = this.desktop.getEnvironment().then(
      (environment) => {
        this.environment.set(environment);
      },
      (error: unknown) => {
        log.warn('Cannot read the environment:', error);
      },
    );
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, LOAD_TIMEOUT_MS));
    await Promise.race([loading, timeout]);
  }
}

/**
 * The release a version string starts with, for people: `n4.4.1` and `4.4.1-full_build-www.gyan.dev`
 * give `4.4.1`. Builds from git (`N-113000-g…`) are named whole.
 */
export function shortVersion(version: string): string {
  return /^n?(\d+(?:\.\d+)+)/.exec(version)?.[1] ?? version;
}
