import type { ElementRef } from '@angular/core';
import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  DOCUMENT,
  effect,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { trackUrl } from '@shared/desktop-api';
import type { AudioTrack } from '@shared/model';
import { formatDuration } from '@shared/time';
import { trackSuffix } from '@shared/track-suffix';
import { FileDrop, TRACKS_DROP_ATTRIBUTE } from '../../core/file-drop';
import { SettingsStore } from '../../core/settings-store';
import { TracksStore } from '../../core/tracks-store';
import { Icon } from '../../ui/icon/icon';

/** Whether a preview can be tried: a track still being read may well play. */
function playable(track: AudioTrack): boolean {
  return track.status === 'ok' || track.status === 'probing';
}

/**
 * The audio list, to choose the replacement soundtrack from, preview one, add or remove some.
 * Audio files dropped on it join it, instead of the video list.
 */
@Component({
  selector: 'app-track-list',
  imports: [Icon],
  templateUrl: './track-list.html',
  styleUrl: './track-list.css',
  host: { [TRACKS_DROP_ATTRIBUTE]: '', '[class.dropping]': 'dropping()' },
})
export class TrackList {
  private readonly store = inject(TracksStore);
  private readonly settings = inject(SettingsStore);
  private readonly drop = inject(FileDrop);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly player = viewChild<ElementRef<HTMLAudioElement>>('player');
  private readonly addButton = viewChild.required<ElementRef<HTMLButtonElement>>('addButton');

  protected readonly tracks = this.store.tracks;
  protected readonly notice = this.store.notice;
  protected readonly selectedId = computed(() => this.settings.recipe().trackId);
  /** Files dragged over the window would join the audio list. */
  protected readonly dropping = computed(() => this.drop.target() === 'tracks');
  /** The track being previewed: one at a time, in the one `<audio>` element. */
  protected readonly playing = signal<string | null>(null);
  protected readonly playable = playable;

  constructor() {
    // A track that leaves the list, or turns out missing, stops playing.
    effect(() => {
      const id = this.playing();
      if (id !== null && !this.tracks().some((track) => track.id === id && playable(track))) {
        this.stop();
      }
    });
    // Choosing another way to treat the audio hides the list: the preview stops with it.
    inject(DestroyRef).onDestroy(() => {
      if (this.playing() !== null) {
        this.stop();
      }
    });
  }

  protected status(track: AudioTrack): string {
    switch (track.status) {
      case 'probing':
        return 'Reading…';
      case 'ok':
        return track.durationSec === null ? '' : formatDuration(track.durationSec);
      case 'missing':
        return 'Missing';
      case 'unreadable':
        return 'Unreadable';
    }
  }

  /** The suffix field opens under the chosen row: the list scrolls to show it, if it has to. */
  protected select(track: AudioTrack, row: HTMLElement): void {
    this.store.select(track.id);
    afterNextRender(
      () => {
        row.scrollIntoView({ block: 'nearest' });
      },
      { injector: this.injector },
    );
  }

  /** What an empty suffix stands for: the file name without its extension, as the suffix keeps it. */
  protected defaultSuffix(track: AudioTrack): string {
    return trackSuffix(null, track.name);
  }

  /**
   * The field lost the focus. Unless the whole window did (another app was activated: the field is
   * still being edited, and stays as typed), the suffix is saved.
   */
  protected leaveSuffix(track: AudioTrack, input: HTMLInputElement): void {
    if (this.document.activeElement !== input) {
      void this.saveSuffix(track, input);
    }
  }

  /**
   * Saves the suffix typed for `track`, then shows the one kept: cleaned up, or the file name for
   * nothing. Unless the user typed on meanwhile.
   */
  protected async saveSuffix(track: AudioTrack, input: HTMLInputElement): Promise<void> {
    const typed = input.value;
    if (typed === track.suffix) {
      return;
    }
    const kept = await this.store.setSuffix(track, typed);
    if (input.value === typed) {
      input.value = kept ?? this.suffixOf(track);
    }
  }

  /** Escape gives up what was typed. */
  protected revertSuffix(track: AudioTrack, input: HTMLInputElement): void {
    input.value = this.suffixOf(track);
  }

  protected toggle(track: AudioTrack): void {
    const audio = this.player()?.nativeElement;
    if (!audio) {
      return;
    }
    this.store.dismissPreviewFailure();
    if (this.playing() === track.id) {
      this.stop();
      return;
    }
    audio.src = trackUrl(track.id);
    this.playing.set(track.id);
    audio.play().catch((error: unknown) => {
      // Interrupted by a pause, or by another preview: nothing went wrong.
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      this.failedToPlay(track.id);
    });
  }

  protected onPlayerError(): void {
    const id = this.playing();
    if (id !== null) {
      this.failedToPlay(id);
    }
  }

  protected choose(): void {
    void this.store.choose();
  }

  /**
   * If the focus was on the track, it goes to the one that takes its place in the list, or to Add
   * audio files.
   */
  protected remove(track: AudioTrack, row: HTMLElement): void {
    if (this.playing() === track.id) {
      this.stop();
    }
    if (row.contains(this.document.activeElement)) {
      const neighbour = row.nextElementSibling ?? row.previousElementSibling;
      (neighbour?.querySelector('input') ?? this.addButton().nativeElement).focus();
    }
    void this.store.remove(track);
  }

  /** The suffix of `track` as listed now: it may have changed since `track` was. */
  private suffixOf(track: AudioTrack): string {
    return this.tracks().find((candidate) => candidate.id === track.id)?.suffix ?? track.suffix;
  }

  private stop(): void {
    this.player()?.nativeElement.pause();
    this.playing.set(null);
  }

  private failedToPlay(id: string): void {
    this.stop();
    this.store.previewFailed(id);
  }
}
