import { createLogger } from '@shared/log';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { errorMessage, execTool } from './exec';

const log = createLogger('media-tools');

export interface MediaTools {
  /** Absolute path of the executable. */
  readonly ffmpeg: string;
  readonly ffprobe: string;
  /** As `ffmpeg -version` reports it, e.g. `7.1-full_build-www.gyan.dev`. */
  readonly version: string;
  /** Encoder names, e.g. `libx264`, `aac`: what re-encoding can use with this build. */
  readonly encoders: ReadonlySet<string>;
  /**
   * Codecs this build can decode, by the names ffprobe gives streams, e.g. `aac`. ffmpeg 9.0 names
   * the spatial audio (APAC) of recent iPhones, `apple_apac`, without decoding it.
   */
  readonly decodable: ReadonlySet<string>;
  /** How this ffmpeg spells the options whose names changed over its versions. */
  readonly features: MediaFeatures;
}

/**
 * Options that exact cuts need, which ffmpeg renamed over the years, then dropped the old names:
 * Linux distributions ship versions years apart (Ubuntu 22.04 has 4.4, Debian 13 7.1). Found by
 * trying them once, as builds from git or from distributions have version strings that say little.
 */
export interface MediaFeatures {
  /**
   * The value of `-enc_time_base` that gives encoded frames the timestamps they were read with:
   * `demux` from ffmpeg 6.1, `-1` before it (and no longer in 9.0); `null` when neither works
   * (ffmpeg older than 3.4, which lacks the option): then exact cuts cannot keep the timestamps.
   */
  readonly demuxTimeBase: 'demux' | '-1' | null;
  /**
   * The option that says whether ffmpeg may drop or duplicate frames: `-fps_mode` from ffmpeg 5.1,
   * the global `-vsync` before it (and no longer in 9.0); `null` when neither works.
   */
  readonly fpsMode: '-fps_mode:v' | '-vsync' | null;
}

/** What current versions have, assumed when the options cannot be tried (see `probeFeatures`). */
const CURRENT_FEATURES = { demuxTimeBase: 'demux', fpsMode: '-fps_mode:v' } as const;

/** Whether this ffmpeg can apply every treatment (see `MediaFeatures`); else none is applied. */
export function isSupported(tools: MediaTools): boolean {
  return tools.features.demuxTimeBase !== null && tools.features.fpsMode !== null;
}

/** The arguments that make ffmpeg time video frames as `mode` says, as this version spells them. */
export function fpsModeArgs(
  features: MediaFeatures,
  mode: 'passthrough' | 'vfr',
): readonly string[] {
  return [features.fpsMode ?? CURRENT_FEATURES.fpsMode, mode];
}

/** Package-manager locations that GUI-launched apps do not get on their PATH (macOS, Linux). */
const WELL_KNOWN_DIRS =
  process.platform === 'win32'
    ? []
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin'];

const RUN_TIMEOUT_MS = 15_000;

/**
 * Finds ffmpeg and ffprobe: `VIDEO_TOOL_FFMPEG_DIR`, then binaries bundled with the app
 * (`<resourcesDir>/bin`), then the PATH, then well-known install locations. Runs them once to read
 * the version, the codecs and encoders, so that a broken install counts as missing, and to try the options
 * that changed (see `MediaFeatures`). Resolves to `null` when either is missing or does not run.
 */
export async function loadMediaTools(resourcesDir: string | null): Promise<MediaTools | null> {
  return loadMediaToolsIn(searchDirs(resourcesDir));
}

/** As `loadMediaTools` does, looking in `dirs` only, in order. */
export async function loadMediaToolsIn(dirs: readonly string[]): Promise<MediaTools | null> {
  const ffmpeg = find('ffmpeg', dirs);
  const ffprobe = find('ffprobe', dirs);
  if (ffmpeg === null || ffprobe === null) {
    log.warn(`Not found: ${ffmpeg === null ? 'ffmpeg' : 'ffprobe'}. Searched ${dirs.join(', ')}`);
    return null;
  }
  try {
    const [version, encoders, codecs, , features] = await Promise.all([
      execTool(ffmpeg, ['-hide_banner', '-version'], { timeoutMs: RUN_TIMEOUT_MS }),
      execTool(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: RUN_TIMEOUT_MS }),
      execTool(ffmpeg, ['-hide_banner', '-codecs'], { timeoutMs: RUN_TIMEOUT_MS }),
      execTool(ffprobe, ['-hide_banner', '-version'], { timeoutMs: RUN_TIMEOUT_MS }),
      probeFeatures(ffmpeg),
    ]);
    const tools: MediaTools = {
      ffmpeg,
      ffprobe,
      version: parseVersion(version.stdout.toString('utf8')),
      encoders: parseEncoders(encoders.stdout.toString('utf8')),
      decodable: parseDecodable(codecs.stdout.toString('utf8')),
      features,
    };
    if (!isSupported(tools)) {
      log.warn(`ffmpeg ${tools.version} is too old: it lacks options exact cuts need.`, features);
    }
    return tools;
  } catch (error) {
    log.warn(`Cannot run ${ffmpeg} or ${ffprobe}:`, errorMessage(error));
    return null;
  }
}

/** A tenth of a second of a tiny generated video, encoded for nothing: enough to try options on. */
const TRIAL_INPUT = ['-f', 'lavfi', '-i', 'color=s=16x16:r=10:d=0.1'];

/**
 * Tries the options of `MediaFeatures`, the current names first. A build that cannot run the trial
 * at all (without the lavfi device) cannot tell: it is taken for a current one.
 */
async function probeFeatures(ffmpeg: string): Promise<MediaFeatures> {
  const accepts = (args: readonly string[]): Promise<boolean> =>
    execTool(
      ffmpeg,
      [
        ...['-hide_banner', '-nostdin', '-loglevel', 'error'],
        ...TRIAL_INPUT,
        ...args,
        ...['-f', 'null', '-'],
      ],
      { timeoutMs: RUN_TIMEOUT_MS },
    ).then(
      () => true,
      () => false,
    );
  /** The first spelling this ffmpeg accepts, tried in turn; `null` when none is. */
  const firstAccepted = async <T>(
    trials: readonly (readonly [T, readonly string[]])[],
  ): Promise<T | null> => {
    for (const [spelling, args] of trials) {
      if (await accepts(args)) {
        return spelling;
      }
    }
    return null;
  };
  const [runs, demuxTimeBase, fpsMode] = await Promise.all([
    accepts([]),
    firstAccepted([
      ['demux', ['-enc_time_base:v', 'demux']],
      ['-1', ['-enc_time_base:v', '-1']],
    ] as const),
    firstAccepted([
      ['-fps_mode:v', ['-fps_mode:v', 'passthrough']],
      ['-vsync', ['-vsync', 'passthrough']],
    ] as const),
  ]);
  if (!runs) {
    log.warn(`Cannot try the options of ${ffmpeg}: taking it for a current version.`);
    return CURRENT_FEATURES;
  }
  return { demuxTimeBase, fpsMode };
}

function searchDirs(resourcesDir: string | null): string[] {
  return [
    process.env['VIDEO_TOOL_FFMPEG_DIR'],
    resourcesDir === null ? undefined : path.join(resourcesDir, 'bin'),
    ...(process.env['PATH'] ?? '').split(path.delimiter),
    ...WELL_KNOWN_DIRS,
  ].filter((dir): dir is string => dir !== undefined && dir.trim() !== '');
}

function find(name: string, dirs: readonly string[]): string | null {
  const file = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of dirs) {
    // PATH entries may be quoted on Windows.
    const candidate = path.resolve(dir.replace(/^"(.*)"$/, '$1'), file);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Not here; keep looking.
    }
  }
  return null;
}

/** `ffmpeg version 7.1-full_build-www.gyan.dev Copyright…` → `7.1-full_build-www.gyan.dev`. */
export function parseVersion(output: string): string {
  const firstLine = output.split(/\r?\n/, 1)[0] ?? '';
  const version = /^ffmpeg version (\S+)/.exec(firstLine)?.[1] ?? firstLine.trim();
  return version === '' ? 'unknown' : version;
}

/**
 * Names of the codecs that can be decoded in the table of `ffmpeg -codecs`, whose rows look like
 * ` DEA.L. aac  AAC (Advanced Audio Coding)…`: `D` first.
 */
export function parseDecodable(output: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*D[E.][VASDT][I.][L.][S.]\s+(\S+)/.exec(line);
    if (match?.[1] !== undefined && match[1] !== '=') {
      names.add(match[1]);
    }
  }
  return names;
}

/** Names from the table of `ffmpeg -encoders`, whose rows look like ` V....D libx264  libx264 H.264…`. */
export function parseEncoders(output: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*[VAS][F.][S.][X.][B.][D.]\s+(\S+)/.exec(line);
    if (match?.[1] !== undefined && match[1] !== '=') {
      names.add(match[1]);
    }
  }
  return names;
}
