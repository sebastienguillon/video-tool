import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { DESKTOP } from '../../core/desktop';
import { SettingsStore } from '../../core/settings-store';
import { FakeDesktop, settle, text } from '../../testing/fake-desktop';
import { OutputSection } from './output-section';

describe('OutputSection', () => {
  let desktop: FakeDesktop;
  let settings: SettingsStore;
  let fixture: ComponentFixture<OutputSection>;
  let host: HTMLElement;

  beforeEach(async () => {
    desktop = new FakeDesktop();
    TestBed.configureTestingModule({ providers: [{ provide: DESKTOP, useValue: desktop }] });
    settings = TestBed.inject(SettingsStore);
    fixture = TestBed.createComponent(OutputSection);
    host = fixture.nativeElement as HTMLElement;
    await render();
  });

  async function render(): Promise<void> {
    await settle();
    await fixture.whenStable();
  }

  it('names the results after their video and the treatments', async () => {
    expect(text(host.querySelector('.hint'))).toBe(
      'Originals are never modified. Results are named after their video, like “clip (no audio).mov” for “clip.mov”.',
    );
    settings.updateRecipe({ audio: 'replace', trimEnd: { amount: 2, unit: 'seconds' } });
    await render();
    expect(text(host.querySelector('.hint'))).toBe(
      'Originals are never modified. Results are named after their video, like “clip (new audio, trimmed).mov” for “clip.mov”.',
    );
    settings.updateRecipe({ audio: 'keep', trimEnd: { amount: 0, unit: 'seconds' } });
    await render();
    expect(text(host.querySelector('.hint'))).toBe('Originals are never modified.');
  });

  it('saves in the folder chosen', async () => {
    desktop.respond('chooseOutputFolder', () => Promise.resolve('E:\\Exports\\été'));
    host.querySelector<HTMLInputElement>('#output-folder')?.click();
    await render();
    const path = host.querySelector('.path');
    expect(text(path)).toBe('E:\\Exports\\été');
    expect(path?.getAttribute('title')).toBe('E:\\Exports\\été');
    expect(desktop.settings.output).toEqual({ location: 'folder', folder: 'E:\\Exports\\été' });
  });

  it('stays next to the videos when no folder is chosen', async () => {
    host.querySelector<HTMLInputElement>('#output-folder')?.click();
    await render();
    expect(host.querySelector<HTMLInputElement>('#output-beside')?.checked).toBe(true);
    expect(host.querySelector('.folder')).toBeNull();
  });
});
