import { execFile } from 'node:child_process';

export interface ExecOptions {
  /** The process is killed past this delay. */
  readonly timeoutMs: number;
  /** Bytes of stdout kept; the process is killed beyond. */
  readonly maxBuffer?: number;
  readonly signal?: AbortSignal;
}

export interface ExecResult {
  readonly stdout: Buffer;
  readonly stderr: string;
}

/** A tool that could not start, exited with an error, timed out or was aborted. */
export class ToolError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ToolError';
    this.stderr = stderr;
  }
}

/**
 * Runs ffmpeg or ffprobe to completion. Arguments go straight to the executable, never through a
 * shell, so paths with spaces, quotes or non-ASCII characters need no escaping.
 */
export function execTool(
  file: string,
  args: readonly string[],
  options: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'buffer',
        windowsHide: true,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        const errors = stderr.toString('utf8');
        if (error) {
          reject(new ToolError(error.message, errors, { cause: error }));
        } else {
          resolve({ stdout, stderr: errors });
        }
      },
    );
  });
}

/** The message of anything thrown. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
