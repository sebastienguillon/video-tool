import type { ElementRef } from '@angular/core';
import {
  afterRenderEffect,
  Component,
  computed,
  DOCUMENT,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { PROCESSABLE_STATES } from '@shared/model';
import { recipeIssue, videoIssue } from '@shared/recipe';
import { EnvironmentStore } from '../../core/environment-store';
import { ItemsStore } from '../../core/items-store';
import { SettingsStore } from '../../core/settings-store';
import { TracksStore } from '../../core/tracks-store';
import { Icon } from '../../ui/icon/icon';

/**
 * Starts a run with the treatments, or says why it cannot start; during a run, its overall progress
 * and a way to stop it.
 */
@Component({
  selector: 'app-process-bar',
  imports: [Icon],
  templateUrl: './process-bar.html',
  styleUrl: './process-bar.css',
})
export class ProcessBar {
  private readonly items = inject(ItemsStore);
  private readonly settings = inject(SettingsStore);
  private readonly tracks = inject(TracksStore);
  private readonly environment = inject(EnvironmentStore);
  private readonly document = inject(DOCUMENT);
  private readonly mainButton = viewChild.required<ElementRef<HTMLButtonElement>>('mainButton');

  protected readonly progress = this.items.progress;
  protected readonly percent = computed(() => Math.floor((this.progress()?.fraction ?? 0) * 100));
  /** Videos a run would process: the others are not ready, or cannot take the treatments. */
  protected readonly count = computed(() => {
    const recipe = this.settings.recipe();
    return this.items
      .items()
      .filter(
        ({ info, state }) =>
          PROCESSABLE_STATES.includes(state.kind) &&
          info !== null &&
          videoIssue(recipe, info) === null,
      ).length;
  });
  /** Why Process is unavailable; `null` when it is not. */
  protected readonly blocker = computed(() => {
    if (this.environment.ffmpegMissing()) {
      return 'Install ffmpeg to process videos.';
    }
    if (this.environment.outdatedVersion() !== null) {
      return 'Update ffmpeg to process videos.';
    }
    const invalid = this.settings.invalidLength();
    if (invalid !== null) {
      return `Enter a valid length to ${invalid}.`;
    }
    const issue = recipeIssue(this.settings.recipe(), this.tracks.selected());
    if (issue !== null) {
      return issue;
    }
    const output = this.settings.output();
    if (output.location === 'folder' && output.folder === null) {
      return 'Choose the folder to save in.';
    }
    return this.count() > 0 ? null : this.nothingToProcess();
  });
  protected readonly label = computed(() => {
    const count = this.count();
    if (count === 0) {
      return 'Process videos';
    }
    return count === 1 ? 'Process 1 video' : `Process ${count} videos`;
  });
  protected readonly starting = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    // Starting or ending a run swaps Process and Stop all: the focus goes along.
    let wasBusy: boolean | null = null;
    afterRenderEffect(() => {
      const busy = this.progress() !== null;
      const active = this.document.activeElement;
      if (
        wasBusy !== null &&
        busy !== wasBusy &&
        (active === null || active === this.document.body)
      ) {
        this.mainButton().nativeElement.focus();
      }
      wasBusy = busy;
    });
  }

  protected async start(): Promise<void> {
    if (this.blocker() !== null || this.starting()) {
      return;
    }
    this.error.set(null);
    this.starting.set(true);
    try {
      // Processing uses the output settings the main process has: they must be saved first.
      await this.settings.flush();
      await this.items.start(this.settings.recipe());
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.starting.set(false);
    }
  }

  protected stop(): void {
    void this.items.cancel(null);
  }

  private nothingToProcess(): string {
    const items = this.items.items();
    if (items.length === 0) {
      return 'Add videos to process.';
    }
    if (items.some((item) => item.state.kind === 'probing')) {
      return 'Reading the videos…';
    }
    if (items.some((item) => PROCESSABLE_STATES.includes(item.state.kind))) {
      return 'None of the videos can take these treatments.';
    }
    // Only done videos have Process again; the others left are files ffprobe cannot read.
    if (items.some((item) => item.state.kind === 'done')) {
      return 'Nothing left to process. Use Process again on a video to redo it.';
    }
    return items.length === 1
      ? 'This file cannot be read as a video.'
      : 'None of these files can be read as a video.';
  }
}
