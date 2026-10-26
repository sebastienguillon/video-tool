import { inject, Injectable, signal } from '@angular/core';
import { DESKTOP } from './desktop';
import { ItemsStore } from './items-store';
import { TracksStore } from './tracks-store';

/** Where dropped files go: the video list, or the audio list. */
export type DropTarget = 'videos' | 'tracks';

/** Marks the area where dropped files join the audio list; anywhere else, they are videos. */
export const TRACKS_DROP_ATTRIBUTE = 'data-drop-tracks';

/**
 * Files dragged from the file manager onto the window, wherever they are dropped. Fed with the
 * document's drag events; drags that carry no files (text, say) are left alone.
 */
@Injectable({ providedIn: 'root' })
export class FileDrop {
  private readonly desktop = inject(DESKTOP);
  private readonly items = inject(ItemsStore);
  private readonly tracks = inject(TracksStore);

  /** Where files dragged over the window would go; `null` when none are. */
  readonly target = signal<DropTarget | null>(null);

  enter(event: DragEvent): void {
    if (!carriesFiles(event)) {
      return;
    }
    event.preventDefault();
    this.target.set(targetOf(event.target));
  }

  over(event: DragEvent): void {
    if (!carriesFiles(event)) {
      return;
    }
    // Allows the drop: without it, Chromium would navigate to the file.
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    this.target.set(targetOf(event.target));
  }

  /**
   * Only a drag that leaves the window leaves for no element: from element to element, Chromium
   * enters the next one first, then leaves the previous one naming the next as `relatedTarget`.
   * Enters and leaves are not counted: when the element under the pointer is rendered again during
   * the drag (a video that finishes, say), its leave goes to the detached element and never reaches
   * the document, so the count would stay off for good.
   */
  leave(event: DragEvent): void {
    if (carriesFiles(event) && event.relatedTarget === null) {
      this.target.set(null);
    }
  }

  drop(event: DragEvent): void {
    if (!carriesFiles(event)) {
      return;
    }
    event.preventDefault();
    this.target.set(null);
    const files = Array.from(event.dataTransfer?.files ?? []);
    // Files that are not on this computer (dragged from a web page, say) have no path.
    const paths = files.map((file) => this.desktop.pathForFile(file)).filter((path) => path !== '');
    const skipped = files.length - paths.length;
    if (targetOf(event.target) === 'tracks') {
      void this.tracks.add(paths, skipped);
    } else {
      void this.items.add(paths, skipped);
    }
  }
}

function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false;
}

function targetOf(node: EventTarget | null): DropTarget {
  return node instanceof Element && node.closest(`[${TRACKS_DROP_ATTRIBUTE}]`) !== null
    ? 'tracks'
    : 'videos';
}
