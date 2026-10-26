import { Component, computed, input } from '@angular/core';

export type IconName =
  | 'alert'
  | 'ban'
  | 'circle-check'
  | 'circle-x'
  | 'clock'
  | 'download'
  | 'external-link'
  | 'film'
  | 'folder-open'
  | 'loader'
  | 'music'
  | 'pause'
  | 'play'
  | 'plus'
  | 'rotate-ccw'
  | 'scissors'
  | 'square'
  | 'x';

/** A symbol from the sprite rendered once by `IconSprite`; sized by `font-size`, coloured by `color`. */
@Component({
  selector: 'app-icon',
  template: `<svg aria-hidden="true" focusable="false"><use [attr.href]="href()" /></svg>`,
  styleUrl: './icon.css',
})
export class Icon {
  readonly name = input.required<IconName>();
  protected readonly href = computed(() => `#icon-${this.name()}`);
}
