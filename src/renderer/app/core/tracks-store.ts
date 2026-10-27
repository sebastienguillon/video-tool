import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { createLogger } from '@shared/log';
import type { AddResult, AudioTrack } from '@shared/model';
import { DESKTOP, ipcErrorMessage } from './desktop';
import type { Notice } from './notice';
import { describeAdd, NoticeBoard } from './notice';
import { SettingsStore } from './settings-store';

const log = createLogger('tracks');

/** The audio list, persisted by the main process: the soundtracks a recipe can put on the videos. */
@Injectable({ providedIn: 'root' })
export class TracksStore {
  private readonly desktop = inject(DESKTOP);
  private readonly settings = inject(SettingsStore);
  private readonly list = signal<readonly AudioTrack[]>([]);
  private readonly board = new NoticeBoard();
  /** A change arrived: the initial listing, if still on its way, is older. */
  private changed = false;
  /**
   * Ids listed before an add, while no track is chosen: the first new one becomes the chosen one,
   * once the list shows it.
   */
  private selectAfter: ReadonlySet<string> | null = null;
  /** The message about the last preview that could not play, and the track it is about. */
  private failedPreview: { readonly trackId: string; readonly notice: Notice | null } | null = null;

  readonly tracks = this.list.asReadonly();
  /** Whether the list arrived from the main process: until then, no track is known to be gone. */
  readonly loaded = signal(false);
  /** What the last action on the list did. */
  readonly notice = this.board.notice;
  /** The replacement audio of the recipe; `null` when none is chosen, or it left the list. */
  readonly selected = computed(() => {
    const id = this.settings.recipe().trackId;
    return id === null ? null : (this.list().find((track) => track.id === id) ?? null);
  });

  constructor() {
    const unsubscribe = this.desktop.onTracksChanged((tracks) => {
      this.changed = true;
      this.apply(tracks);
    });
    inject(DestroyRef).onDestroy(unsubscribe);
    this.desktop
      .listTracks()
      .then((tracks) => {
        if (!this.changed) {
          this.apply(tracks);
        }
      })
      .catch((error: unknown) => {
        log.error('Cannot list the audio files:', error);
      });
  }

  /** Adds audio files by path, then says what was added. */
  async add(paths: readonly string[], skipped = 0): Promise<void> {
    if (paths.length === 0) {
      this.board.info('Only files on this computer can be added.');
      return;
    }
    const before = this.ids();
    try {
      const result = await this.desktop.addTracks(paths);
      this.board.info(describeAdd(result, 'tracks', skipped));
      this.selectFirstAdded(before, result);
    } catch (error) {
      log.warn('Cannot add audio files:', error);
      this.board.error(`Cannot add the audio files: ${ipcErrorMessage(error)}`);
    }
  }

  async choose(): Promise<void> {
    const before = this.ids();
    try {
      const result = await this.desktop.chooseTracks();
      if (result) {
        this.board.info(describeAdd(result, 'tracks'));
        this.selectFirstAdded(before, result);
      }
    } catch (error) {
      log.warn('Cannot add audio files:', error);
      this.board.error(`Cannot add the audio files: ${ipcErrorMessage(error)}`);
    }
  }

  select(id: string): void {
    this.settings.updateRecipe({ trackId: id });
  }

  /**
   * Says that a preview could not play, like any other message about the list: the newest one is
   * shown, whichever it is.
   */
  previewFailed(trackId: string): void {
    const track = this.list().find((candidate) => candidate.id === trackId);
    this.board.error(`Cannot play ${track?.name ?? 'this audio file'}.`);
    this.failedPreview = { trackId, notice: this.board.notice() };
  }

  /**
   * Another preview is tried, or the track is removed: why the last one could not play is old news,
   * unless a newer message replaced it already.
   */
  dismissPreviewFailure(trackId?: string): void {
    const failed = this.failedPreview;
    if (failed === null || (trackId !== undefined && failed.trackId !== trackId)) {
      return;
    }
    this.failedPreview = null;
    if (this.board.notice() === failed.notice) {
      this.board.clear();
    }
  }

  /**
   * Sets what the names of results say of a track. Resolves to the suffix kept, cleaned up by the
   * main process; `null` when the track left the list, or the suffix could not be changed.
   */
  async setSuffix(track: AudioTrack, suffix: string): Promise<string | null> {
    try {
      return await this.desktop.setTrackSuffix(track.id, suffix);
    } catch (error) {
      log.warn('Cannot change the suffix of an audio file:', error);
      this.board.error(`Cannot change the suffix of ${track.name}: ${ipcErrorMessage(error)}`);
      return null;
    }
  }

  /** Forgets a track (the file stays); the recipe no longer uses it. */
  async remove(track: AudioTrack): Promise<void> {
    this.dismissPreviewFailure(track.id);
    if (this.settings.recipe().trackId === track.id) {
      this.settings.updateRecipe({ trackId: null });
    }
    try {
      await this.desktop.removeTrack(track.id);
    } catch (error) {
      log.warn('Cannot remove an audio file:', error);
      this.board.error(`Cannot remove ${track.name}: ${ipcErrorMessage(error)}`);
    }
  }

  private ids(): ReadonlySet<string> {
    return new Set(this.list().map((track) => track.id));
  }

  /** Adding the first soundtrack, or another one while none is chosen, means using it. */
  private selectFirstAdded(before: ReadonlySet<string>, result: AddResult): void {
    if (result.added > 0 && this.settings.recipe().trackId === null) {
      this.selectAfter = before;
      this.selectPending();
    }
  }

  private selectPending(): void {
    const before = this.selectAfter;
    const added = before && this.list().find((track) => !before.has(track.id));
    if (added) {
      this.selectAfter = null;
      if (this.settings.recipe().trackId === null) {
        this.select(added.id);
      }
    }
  }

  private apply(tracks: readonly AudioTrack[]): void {
    this.list.set(tracks);
    this.loaded.set(true);
    this.selectPending();
  }
}
