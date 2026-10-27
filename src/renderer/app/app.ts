import { Component, inject } from '@angular/core';
import { DESKTOP } from './core/desktop';
import { EnvironmentStore } from './core/environment-store';
import { FileDrop } from './core/file-drop';
import { ItemsStore } from './core/items-store';
import { Toolbar } from './toolbar/toolbar';
import { AudioSection } from './treatments/audio-section/audio-section';
import { OutputSection } from './treatments/output-section/output-section';
import { ProcessBar } from './treatments/process-bar/process-bar';
import { SilenceSection } from './treatments/silence-section/silence-section';
import { TrimSection } from './treatments/trim-section/trim-section';
import { Icon } from './ui/icon/icon';
import { IconSprite } from './ui/icon/icon-sprite';
import { Workspace } from './workspace/workspace';

/** The single window: toolbar, the video list on the left, the treatments on the right. */
@Component({
  selector: 'app-root',
  imports: [
    IconSprite,
    Icon,
    Toolbar,
    Workspace,
    AudioSection,
    SilenceSection,
    TrimSection,
    OutputSection,
    ProcessBar,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
  host: {
    '(document:dragenter)': 'drop.enter($event)',
    '(document:dragover)': 'drop.over($event)',
    '(document:dragleave)': 'drop.leave($event)',
    '(document:drop)': 'drop.drop($event)',
    '(document:keydown)': 'onGlobalKeydown($event)',
  },
})
export class App {
  private readonly items = inject(ItemsStore);
  private readonly isMac = inject(DESKTOP).platform === 'darwin';
  protected readonly drop = inject(FileDrop);
  protected readonly environment = inject(EnvironmentStore);

  protected onGlobalKeydown(event: KeyboardEvent): void {
    const modifier = this.isMac ? event.metaKey : event.ctrlKey;
    if (modifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      void this.items.choose();
    }
  }
}
