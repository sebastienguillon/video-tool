import type { ElementRef } from '@angular/core';
import {
  afterNextRender,
  Component,
  computed,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { DESKTOP } from '../core/desktop';
import { ItemsStore } from '../core/items-store';
import { Icon } from '../ui/icon/icon';

/** The title bar: the app name and the actions on the whole list. */
@Component({
  selector: 'app-toolbar',
  imports: [Icon],
  templateUrl: './toolbar.html',
  styleUrl: './toolbar.css',
})
export class Toolbar {
  private readonly items = inject(ItemsStore);
  private readonly injector = inject(Injector);
  private readonly platform = inject(DESKTOP).platform;
  private readonly addButton = viewChild.required<ElementRef<HTMLButtonElement>>('addButton');
  private readonly clearAllButton = viewChild<ElementRef<HTMLButtonElement>>('clearAllButton');
  private readonly cancelButton = viewChild<ElementRef<HTMLButtonElement>>('cancelButton');

  protected readonly shortcut = this.platform === 'darwin' ? '⌘O' : 'Ctrl+O';
  protected readonly empty = computed(() => this.items.items().length === 0);
  protected readonly finishedCount = this.items.finishedCount;
  protected readonly busy = this.items.busy;
  /** Clearing everything while videos are processed stops them: that is asked first. */
  protected readonly confirmingClear = signal(false);

  protected add(): void {
    void this.items.choose();
  }

  protected clearFinished(): void {
    void this.items.clear('finished');
    // Clear finished is about to be disabled: the focus goes to the next thing to do, as after
    // Clear all. Not to Clear all itself, which a second Enter would then press.
    this.afterRender(() => this.addButton().nativeElement.focus());
  }

  protected askClearAll(): void {
    if (!this.busy()) {
      this.clearAll();
      return;
    }
    this.confirmingClear.set(true);
    // Cancel is the safe default for a destructive action.
    this.afterRender(() => this.cancelButton()?.nativeElement.focus());
  }

  /** Cancel or Escape: nothing is cleared, and the focus goes back to Clear all. */
  protected cancelClear(event?: Event): void {
    event?.preventDefault();
    this.confirmingClear.set(false);
    this.afterRender(() => this.clearAllButton()?.nativeElement.focus());
  }

  protected clearAll(): void {
    this.confirmingClear.set(false);
    void this.items.clear('all');
    // Clear all is about to be disabled: the focus goes to the next thing to do.
    this.afterRender(() => this.addButton().nativeElement.focus());
  }

  private afterRender(callback: () => void): void {
    afterNextRender(callback, { injector: this.injector });
  }
}
