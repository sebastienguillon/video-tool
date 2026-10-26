import { signal } from '@angular/core';
import type { AddResult } from '@shared/model';
import { FOLDER_FILE_LIMIT } from '@shared/model';

/** A message for a live region: what an action did, or why it failed. */
export interface Notice {
  readonly text: string;
  readonly tone: 'info' | 'warning' | 'error';
}

/** Information is gone after this long; warnings and errors stay until the next message. */
const INFO_LIFETIME_MS = 8_000;

/** The latest message of one area of the window. */
export class NoticeBoard {
  private readonly current = signal<Notice | null>(null);
  private timer: ReturnType<typeof setTimeout> | undefined;

  readonly notice = this.current.asReadonly();

  info(text: string): void {
    this.show({ text, tone: 'info' });
    this.timer = setTimeout(() => {
      this.current.set(null);
    }, INFO_LIFETIME_MS);
  }

  /** Something to act on, though nothing failed. */
  warning(text: string): void {
    this.show({ text, tone: 'warning' });
  }

  error(text: string): void {
    this.show({ text, tone: 'error' });
  }

  clear(): void {
    clearTimeout(this.timer);
    this.current.set(null);
  }

  private show(notice: Notice): void {
    clearTimeout(this.timer);
    this.current.set(notice);
  }
}

const WORDS = {
  videos: { one: 'video', many: 'videos', notOne: 'not a video', notMany: 'not videos' },
  tracks: { one: 'audio file', many: 'audio files', notOne: 'not audio', notMany: 'not audio' },
} as const;

/** `5,000`, as the rest of the copy, in English. */
function count(value: number): string {
  return value.toLocaleString('en');
}

/**
 * What adding files did, in a line: `3 videos added · 1 already in the list · 2 files ignored: not
 * videos`. `skipped` counts dropped items that are not local files, which never reach the main
 * process: they are ignored too.
 */
export function describeAdd(result: AddResult, list: 'videos' | 'tracks', skipped = 0): string {
  const words = WORDS[list];
  const ignored = result.ignored + skipped;
  const parts: string[] = [];
  if (result.added > 0) {
    parts.push(`${count(result.added)} ${result.added === 1 ? words.one : words.many} added`);
  }
  if (result.duplicates > 0) {
    parts.push(`${count(result.duplicates)} already in the list`);
  }
  if (ignored > 0) {
    parts.push(
      ignored === 1
        ? `1 file ignored: ${words.notOne}`
        : `${count(ignored)} files ignored: ${words.notMany}`,
    );
  }
  if (result.truncated) {
    // The same folders dropped again would stop at the same files: the rest needs its own drops.
    parts.push(
      `stopped at ${count(FOLDER_FILE_LIMIT)} ${words.many} from folders: drop the rest separately`,
    );
  }
  return parts.length === 0 ? `No ${words.many} found.` : parts.join(' · ');
}
