import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { DEFAULT_RECIPE, DEFAULT_SETTINGS } from '@shared/model';
import { DESKTOP } from '../../core/desktop';
import { SettingsStore } from '../../core/settings-store';
import { FakeDesktop, settle, text } from '../../testing/fake-desktop';
import { SilenceSection } from './silence-section';

describe('SilenceSection', () => {
  let desktop: FakeDesktop;
  let settings: SettingsStore;
  let fixture: ComponentFixture<SilenceSection>;
  let host: HTMLElement;

  beforeEach(async () => {
    desktop = new FakeDesktop();
    desktop.settings = { ...DEFAULT_SETTINGS, recipe: { ...DEFAULT_RECIPE, audio: 'keep' } };
    TestBed.configureTestingModule({ providers: [{ provide: DESKTOP, useValue: desktop }] });
    settings = TestBed.inject(SettingsStore);
    await settings.load();
    fixture = TestBed.createComponent(SilenceSection);
    host = fixture.nativeElement as HTMLElement;
    await render();
  });

  async function render(): Promise<void> {
    await settle();
    await fixture.whenStable();
  }

  const inputs = (): HTMLInputElement[] => [...host.querySelectorAll('input')];
  const hint = (): string => text(host.querySelector(':scope > section > .hint'));
  const type = async (field: HTMLInputElement, typed: string): Promise<void> => {
    field.value = typed;
    field.dispatchEvent(new Event('input'));
    await render();
  };

  it('asks how long to silence at the start and at the end', () => {
    expect(text(host.querySelector('h2'))).toBe('Silence');
    expect([...host.querySelectorAll('label')].map(text)).toEqual([
      'Silence the start',
      'Silence the end',
    ]);
    expect(hint()).toBe('Counted on the result, after the trims.');
  });

  it('sets the silences of the recipe, and says what they cost', async () => {
    const [start, end] = inputs();
    await type(start!, '1.5');
    expect(settings.recipe().silenceStart).toEqual({ amount: 1.5, unit: 'seconds' });
    expect(hint()).toBe(
      'Counted on the result, after the trims. Re-encodes the audio, never the video.',
    );

    const unit = host.querySelectorAll('select')[1]!;
    unit.value = 'frames';
    unit.dispatchEvent(new Event('change'));
    await render();
    await type(end!, '12');
    expect(settings.recipe().silenceEnd).toEqual({ amount: 12, unit: 'frames' });

    await settings.flush();
    expect(desktop.settings.recipe).toMatchObject({
      silenceStart: { amount: 1.5, unit: 'seconds' },
      silenceEnd: { amount: 12, unit: 'frames' },
    });
  });

  it('has nothing to silence while the audio is removed', async () => {
    settings.updateRecipe({ silenceEnd: { amount: 1, unit: 'seconds' } });
    settings.updateRecipe({ audio: 'remove' });
    await render();
    expect(inputs()).toEqual([]);
    expect(hint()).toBe('The audio is removed: there is nothing to silence.');
    settings.updateRecipe({ audio: 'replace' });
    await render();
    expect(inputs()[1]?.value).toBe('1');
  });

  it('forgets text that was not a length once the fields are shown again', async () => {
    await type(inputs()[0]!, 'soon');
    expect(settings.invalidLength()).toBe('silence');
    settings.updateRecipe({ audio: 'remove' });
    await render();
    expect(settings.invalidLength()).toBeNull();
    settings.updateRecipe({ audio: 'keep' });
    await render();
    expect(inputs()[0]?.value).toBe('');
    expect(settings.invalidLength()).toBeNull();
  });
});
