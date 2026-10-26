import { afterRenderEffect, Component, computed, DOCUMENT, inject, viewChild } from '@angular/core';
import { FileDrop } from '../core/file-drop';
import { ItemsStore } from '../core/items-store';
import { Icon } from '../ui/icon/icon';
import { DropZone } from './drop-zone/drop-zone';
import { VideoList } from './video-list/video-list';

/** The video list, or the drop zone while it is empty, above a status line. */
@Component({
  selector: 'app-workspace',
  imports: [Icon, DropZone, VideoList],
  templateUrl: './workspace.html',
  styleUrl: './workspace.css',
})
export class Workspace {
  private readonly store = inject(ItemsStore);
  private readonly drop = inject(FileDrop);
  private readonly document = inject(DOCUMENT);
  private readonly dropZone = viewChild(DropZone);

  protected readonly empty = computed(() => this.store.items().length === 0);
  protected readonly notice = this.store.notice;
  /** Files are dragged over the window, and would be added as videos. */
  protected readonly dragging = computed(() => this.drop.target() === 'videos');
  /** `12 videos · 3 done · 1 failed`. */
  protected readonly summary = computed(() => {
    const items = this.store.items();
    if (items.length === 0) {
      return '';
    }
    const done = items.filter((item) => item.state.kind === 'done').length;
    const failed = items.filter((item) => item.state.kind === 'failed').length;
    return [
      `${items.length} ${items.length === 1 ? 'video' : 'videos'}`,
      done > 0 ? `${done} done` : null,
      failed > 0 ? `${failed} failed` : null,
    ]
      .filter((part) => part !== null)
      .join(' · ');
  });

  constructor() {
    // The last video leaving the list takes its row away, and the focus with it: the drop zone,
    // which replaces the list, gets it.
    let wasEmpty: boolean | null = null;
    afterRenderEffect(() => {
      const empty = this.empty();
      const active = this.document.activeElement;
      if (wasEmpty === false && empty && (active === null || active === this.document.body)) {
        this.dropZone()?.focus();
      }
      wasEmpty = empty;
    });
  }
}
