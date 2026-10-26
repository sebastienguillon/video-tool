import { Component, computed, inject } from '@angular/core';
import type { AudioMode } from '@shared/model';
import { SettingsStore } from '../../core/settings-store';
import { Icon } from '../../ui/icon/icon';
import { TrackList } from '../track-list/track-list';

const MODES: readonly { readonly value: AudioMode; readonly label: string }[] = [
  { value: 'keep', label: 'Keep' },
  { value: 'remove', label: 'Remove' },
  { value: 'replace', label: 'Replace' },
];

/** Keep, remove or replace the sound; replacing picks a soundtrack from the audio list. */
@Component({
  selector: 'app-audio-section',
  imports: [Icon, TrackList],
  templateUrl: './audio-section.html',
  styleUrl: './audio-section.css',
})
export class AudioSection {
  private readonly settings = inject(SettingsStore);

  protected readonly modes = MODES;
  protected readonly mode = computed(() => this.settings.recipe().audio);
  protected readonly loop = computed(() => this.settings.recipe().loop);

  protected setMode(audio: AudioMode): void {
    this.settings.updateRecipe({ audio });
  }

  protected setLoop(event: Event): void {
    this.settings.updateRecipe({ loop: (event.target as HTMLInputElement).checked });
  }
}
