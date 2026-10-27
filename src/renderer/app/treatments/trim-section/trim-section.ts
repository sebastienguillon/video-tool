import { Component, computed, inject } from '@angular/core';
import type { CutPrecision, Trim } from '@shared/model';
import { trims } from '@shared/recipe';
import type { LengthKey } from '../../core/settings-store';
import { SettingsStore } from '../../core/settings-store';
import { Icon } from '../../ui/icon/icon';
import { LengthField } from '../length-field/length-field';

/** What to cut at the start and at the end, and how precisely, once there is something to cut. */
@Component({
  selector: 'app-trim-section',
  imports: [Icon, LengthField],
  templateUrl: './trim-section.html',
  styleUrl: './trim-section.css',
})
export class TrimSection {
  private readonly settings = inject(SettingsStore);

  protected readonly recipe = this.settings.recipe;
  protected readonly trimming = computed(() => trims(this.recipe()));

  protected setTrim(field: 'trimStart' | 'trimEnd', trim: Trim): void {
    this.settings.updateRecipe(field === 'trimStart' ? { trimStart: trim } : { trimEnd: trim });
  }

  protected setValidity(field: LengthKey, valid: boolean): void {
    this.settings.setLengthValidity(field, valid);
  }

  protected setPrecision(precision: CutPrecision): void {
    this.settings.updateRecipe({ precision });
  }
}
