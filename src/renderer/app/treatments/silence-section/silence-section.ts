import { Component, computed, inject } from '@angular/core';
import type { Trim } from '@shared/model';
import { silences } from '@shared/recipe';
import type { LengthKey } from '../../core/settings-store';
import { SettingsStore } from '../../core/settings-store';
import { Icon } from '../../ui/icon/icon';
import { LengthField } from '../length-field/length-field';

/** How long the audio, kept or new, is muted at the start and at the end of the result. */
@Component({
  selector: 'app-silence-section',
  imports: [Icon, LengthField],
  templateUrl: './silence-section.html',
  styleUrl: './silence-section.css',
})
export class SilenceSection {
  private readonly settings = inject(SettingsStore);

  protected readonly recipe = this.settings.recipe;
  protected readonly removed = computed(() => this.recipe().audio === 'remove');
  protected readonly silencing = computed(() => silences(this.recipe()));

  protected setSilence(field: 'silenceStart' | 'silenceEnd', length: Trim): void {
    this.settings.updateRecipe(
      field === 'silenceStart' ? { silenceStart: length } : { silenceEnd: length },
    );
  }

  protected setValidity(field: LengthKey, valid: boolean): void {
    this.settings.setLengthValidity(field, valid);
  }
}
