import type { ElementRef } from '@angular/core';
import { Component, computed, inject, viewChildren } from '@angular/core';
import type { OutputLocation } from '@shared/model';
import { outputLabels } from '@shared/recipe';
import { SettingsStore } from '../../core/settings-store';
import { Icon } from '../../ui/icon/icon';

/** Where the results go, and what they are named. */
@Component({
  selector: 'app-output-section',
  imports: [Icon],
  templateUrl: './output-section.html',
  styleUrl: './output-section.css',
})
export class OutputSection {
  private readonly settings = inject(SettingsStore);
  private readonly radios = viewChildren<ElementRef<HTMLInputElement>>('location');

  protected readonly output = this.settings.output;
  /**
   * An example name, for the current treatments. Of a MOV, not an MP4: a result keeps the format of
   * its video, as far as the format allows.
   */
  protected readonly example = computed(() => {
    const labels = outputLabels(this.settings.recipe());
    return labels.length === 0 ? null : `clip (${labels.join(', ')}).mov`;
  });

  protected async setLocation(location: OutputLocation): Promise<void> {
    await this.settings.setLocation(location);
    // Canceling the folder dialog keeps the location, but the radio button clicked stays checked.
    const current = this.output().location;
    for (const { nativeElement: radio } of this.radios()) {
      radio.checked = radio.value === current;
    }
  }

  protected chooseFolder(): void {
    void this.settings.chooseOutputFolder();
  }
}
