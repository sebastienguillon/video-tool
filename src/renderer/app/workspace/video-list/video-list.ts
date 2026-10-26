import { Component, DOCUMENT, inject } from '@angular/core';
import type { QueueItem } from '@shared/model';
import { ItemsStore } from '../../core/items-store';
import { VideoRow } from '../video-row/video-row';

/**
 * The videos, one row each. Rows take the focus: the arrow keys move between them, Delete or
 * Backspace removes the focused one (unless it is being processed).
 */
@Component({
  selector: 'app-video-list',
  imports: [VideoRow],
  templateUrl: './video-list.html',
  styleUrl: './video-list.css',
})
export class VideoList {
  private readonly store = inject(ItemsStore);
  private readonly document = inject(DOCUMENT);

  protected readonly items = this.store.items;

  protected onKeydown(event: KeyboardEvent, item: QueueItem): void {
    const row = event.currentTarget as HTMLElement;
    // Keys pressed on the row's buttons are theirs.
    if (event.target !== row) {
      return;
    }
    const list = row.parentElement;
    const targets: Partial<Record<string, Element | null | undefined>> = {
      ArrowDown: row.nextElementSibling,
      ArrowUp: row.previousElementSibling,
      Home: list?.firstElementChild,
      End: list?.lastElementChild,
    };
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (item.state.kind !== 'running') {
        event.preventDefault();
        this.remove(item, row);
      }
    } else if (event.key in targets) {
      event.preventDefault();
      const target = targets[event.key];
      if (target instanceof HTMLElement) {
        target.focus();
      }
    }
  }

  /**
   * Removes a video; if the focus was on its row, it goes to the row that takes its place. The last
   * one leaves the drop zone in place of the list, which takes the focus then (see `Workspace`).
   */
  protected remove(item: QueueItem, row: HTMLElement): void {
    const neighbour = row.nextElementSibling ?? row.previousElementSibling;
    if (row.contains(this.document.activeElement) && neighbour instanceof HTMLElement) {
      neighbour.focus();
    }
    void this.store.remove([item.id]);
  }

  /** The button of the row that had the focus is about to go: the row takes it. */
  protected keepFocus(row: HTMLElement): void {
    if (row.contains(this.document.activeElement)) {
      row.focus();
    }
  }
}
