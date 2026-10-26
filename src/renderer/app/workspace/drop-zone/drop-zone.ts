import type { ElementRef } from '@angular/core';
import { Component, inject, input, viewChild } from '@angular/core';
import { ItemsStore } from '../../core/items-store';
import { Icon } from '../../ui/icon/icon';

/** What the empty list shows: where to drop videos, or a button to choose them. */
@Component({
  selector: 'app-drop-zone',
  imports: [Icon],
  templateUrl: './drop-zone.html',
  styleUrl: './drop-zone.css',
})
export class DropZone {
  private readonly items = inject(ItemsStore);
  private readonly chooseButton = viewChild.required<ElementRef<HTMLButtonElement>>('chooseButton');

  /** Files are dragged over the window. */
  readonly active = input(false);

  focus(): void {
    this.chooseButton().nativeElement.focus();
  }

  protected choose(): void {
    void this.items.choose();
  }
}
