import { Component, computed, inject, input, linkedSignal, LOCALE_ID, output } from '@angular/core';
import { thumbnailUrl } from '@shared/desktop-api';
import type { QueueItem } from '@shared/model';
import { PROCESSABLE_STATES } from '@shared/model';
import { videoIssue } from '@shared/recipe';
import { DESKTOP, revealLabel } from '../../core/desktop';
import { ItemsStore } from '../../core/items-store';
import { SettingsStore } from '../../core/settings-store';
import { describeVideo } from '../../ui/format/media';
import { Icon } from '../../ui/icon/icon';

/**
 * A video of the list: thumbnail, name, what ffprobe found, where it stands, and what can be done
 * with it. Only rendered again when its item changes, not when another one makes progress.
 */
@Component({
  selector: 'app-video-row',
  imports: [Icon],
  templateUrl: './video-row.html',
  styleUrl: './video-row.css',
})
export class VideoRow {
  private readonly store = inject(ItemsStore);
  private readonly settings = inject(SettingsStore);
  private readonly locale = inject(LOCALE_ID);
  private readonly platform = inject(DESKTOP).platform;

  readonly item = input.required<QueueItem>();
  /** Remove was asked for: the list removes it, and moves the focus. */
  readonly removeRequested = output();
  /**
   * Process again, Retry and Cancel give way to other buttons once the video changes state: the
   * list moves the focus to the row first, so that it is not lost.
   */
  readonly rowFocusRequested = output();

  protected readonly revealLabel = revealLabel(this.platform);
  /** Only probed videos have a still. */
  protected readonly thumbnail = computed(() => {
    const { id, state } = this.item();
    return state.kind === 'probing' || state.kind === 'unsupported' ? null : thumbnailUrl(id);
  });
  protected readonly loaded = linkedSignal({ source: this.thumbnail, computation: () => false });
  protected readonly failed = linkedSignal({ source: this.thumbnail, computation: () => false });
  protected readonly details = computed(() => {
    const { info } = this.item();
    return info === null ? null : describeVideo(info, this.locale);
  });
  /** Why the treatments cannot apply to this video, when it would be processed. */
  protected readonly issue = computed(() => {
    const { info, state } = this.item();
    return info !== null && PROCESSABLE_STATES.includes(state.kind)
      ? videoIssue(this.settings.recipe(), info)
      : null;
  });
  /** Of a video being processed: whole percents, `null` until ffmpeg reports. */
  protected readonly percent = computed(() => {
    const { state } = this.item();
    return state.kind === 'running' && state.progress !== null
      ? Math.floor(state.progress * 100)
      : null;
  });
  protected readonly speed = computed(() => {
    const { state } = this.item();
    return state.kind === 'running' && state.speed !== null ? `${state.speed.toFixed(1)}×` : null;
  });

  protected openSource(): void {
    void this.store.open(this.item(), 'source');
  }

  protected revealSource(): void {
    void this.store.reveal(this.item(), 'source');
  }

  protected openOutput(): void {
    void this.store.open(this.item(), 'output');
  }

  protected revealOutput(): void {
    void this.store.reveal(this.item(), 'output');
  }

  protected cancel(): void {
    this.rowFocusRequested.emit();
    void this.store.cancel([this.item().id]);
  }

  /** Done, failed or canceled: back to ready, for the next run. */
  protected reset(): void {
    this.rowFocusRequested.emit();
    void this.store.reset([this.item().id]);
  }
}
