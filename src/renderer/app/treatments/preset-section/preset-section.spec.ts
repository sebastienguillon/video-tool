import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import type { Preset } from '@shared/model';
import { DEFAULT_RECIPE, DEFAULT_SETTINGS } from '@shared/model';
import { DESKTOP } from '../../core/desktop';
import { SettingsStore } from '../../core/settings-store';
import { audioTrack, FakeDesktop, settle, text } from '../../testing/fake-desktop';
import { PresetSection } from './preset-section';

const seconds = (amount: number) => ({ amount, unit: 'seconds' }) as const;
const frames = (amount: number) => ({ amount, unit: 'frames' }) as const;

const TIKTOK: Preset = {
  id: 'tiktok',
  name: 'TikTok',
  trim: { trimStart: seconds(0), trimEnd: frames(12), precision: 'exact' },
};
const BEACH: Preset = {
  id: 'beach',
  name: 'beach music',
  audio: { audio: 'replace', trackId: 'waves', loop: true },
  output: { location: 'folder', folder: 'D:\\Reels' },
};

describe('PresetSection', () => {
  let desktop: FakeDesktop;
  let settings: SettingsStore;
  let fixture: ComponentFixture<PresetSection>;
  let host: HTMLElement;

  async function create(presets: readonly Preset[]): Promise<void> {
    desktop.presets = presets;
    TestBed.configureTestingModule({ providers: [{ provide: DESKTOP, useValue: desktop }] });
    settings = TestBed.inject(SettingsStore);
    await settings.load();
    fixture = TestBed.createComponent(PresetSection);
    host = fixture.nativeElement as HTMLElement;
    document.body.append(host);
    await render();
  }

  beforeEach(() => {
    desktop = new FakeDesktop();
    desktop.tracks = [audioTrack('waves')];
    desktop.settings = {
      ...DEFAULT_SETTINGS,
      recipe: { ...DEFAULT_RECIPE, audio: 'keep', trimEnd: frames(12), silenceEnd: seconds(1) },
    };
  });

  afterEach(() => {
    host.remove();
  });

  async function render(): Promise<void> {
    await settle();
    await fixture.whenStable();
    await settle();
  }

  const menu = (): HTMLSelectElement | null => host.querySelector('select');
  const options = (): string[] => [...(menu()?.options ?? [])].map((option) => text(option));
  const buttons = (): string[] =>
    [...host.querySelectorAll('button')].map((button) => text(button));
  const button = (name: string): HTMLButtonElement => {
    const found = [...host.querySelectorAll('button')].find(
      (candidate) => text(candidate) === name || candidate.getAttribute('aria-label') === name,
    );
    if (found === undefined) {
      throw new Error(`No button ${name} in: ${buttons().join(', ')}`);
    }
    return found;
  };
  const click = async (name: string): Promise<void> => {
    button(name).click();
    await render();
  };
  const summary = (): string => text(host.querySelector('#preset-summary'));
  const error = (): string => text(host.querySelector('[role="alert"].error-text'));
  const nameInput = (): HTMLInputElement => host.querySelector('#preset-name') as HTMLInputElement;
  const typeName = async (name: string): Promise<void> => {
    nameInput().value = name;
    nameInput().dispatchEvent(new Event('input'));
    await render();
  };
  const checkbox = (label: string): HTMLInputElement => {
    const found = [...host.querySelectorAll('label')].find(
      (candidate) => text(candidate) === label,
    );
    return host.querySelector(`#${found?.htmlFor ?? 'none'}`) as HTMLInputElement;
  };
  const submit = async (): Promise<void> => {
    host.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await render();
  };
  const choose = async (value: string): Promise<void> => {
    const select = menu();
    if (select === null) {
      throw new Error('No preset menu');
    }
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await render();
  };

  it('offers to save the treatments while there is no preset yet', async () => {
    await create([]);
    expect(menu()).toBeNull();
    expect(text(host.querySelector('.hint'))).toBe(
      'Save the treatments as a preset, to set them again in one go.',
    );
    expect(buttons()).toEqual(['Save as preset…']);
  });

  it('saves the sections chosen as a new preset, which becomes the current one', async () => {
    await create([]);
    await click('Save as preset…');
    expect(document.activeElement).toBe(nameInput());
    // What the treatments use is ticked, where to save is not; each says what it would keep.
    const sets = [...host.querySelectorAll('.choice')].map((choice) => [
      text(choice.querySelector('label')),
      text(choice.querySelector('.description')),
    ]);
    expect(sets).toEqual([
      ['Audio', 'Keep'],
      ['Silence', 'End 1 s'],
      ['Trim', 'End 12 frames, exact'],
      ['Save to', 'Next to each video'],
    ]);
    expect(['Audio', 'Silence', 'Trim', 'Save to'].map((label) => checkbox(label).checked)).toEqual(
      [true, true, true, false],
    );

    await typeName('  TikTok ');
    checkbox('Audio').click();
    checkbox('Silence').click();
    await render();
    await submit();

    expect(desktop.callsTo('savePreset')).toEqual([
      [
        {
          name: '  TikTok ',
          trim: { trimStart: seconds(0), trimEnd: frames(12), precision: 'exact' },
        },
      ],
    ]);
    expect(options()).toEqual(['No preset', 'TikTok']);
    expect(menu()?.value).toBe('preset-1');
    expect(document.activeElement).toBe(menu());
    expect(summary()).toBe('Sets the trims.');
    expect(desktop.settings.presetId).toBe('preset-1');
  });

  it('says why a preset cannot be saved, and keeps the form open', async () => {
    await create([TIKTOK]);
    await click('Save as preset…');
    await submit();
    expect(error()).toBe('Name the preset.');
    await typeName('tiktok');
    await submit();
    expect(error()).toBe('A preset is already named “TikTok”.');
    await typeName('Reels');
    for (const label of ['Audio', 'Silence', 'Trim']) {
      checkbox(label).click();
    }
    await render();
    await submit();
    expect(error()).toBe('Choose what the preset sets.');
    expect(desktop.callsTo('savePreset')).toEqual([]);

    // The main process may refuse it too.
    desktop.respond('savePreset', () =>
      Promise.reject(new Error("Error invoking remote method 'presets:save': Error: Disk full.")),
    );
    checkbox('Trim').click();
    await render();
    await submit();
    expect(error()).toBe('Disk full.');
    expect(nameInput()).not.toBeNull();
  });

  it('applies the preset chosen, to the sections it sets only', async () => {
    await create([TIKTOK, BEACH]);
    expect(options()).toEqual(['No preset', 'beach music', 'TikTok']);
    expect(summary()).toBe('Choose one to set the treatments it holds.');

    await choose('beach');
    expect(settings.recipe()).toMatchObject({
      audio: 'replace',
      trackId: 'waves',
      trimEnd: frames(12),
      silenceEnd: seconds(1),
    });
    expect(settings.output()).toEqual({ location: 'folder', folder: 'D:\\Reels' });
    expect(summary()).toBe('Sets the audio and where to save.');
    expect(desktop.settings.presetId).toBe('beach');

    // No preset: the treatments stay.
    await choose('');
    expect(settings.recipe().audio).toBe('replace');
    expect(desktop.settings.presetId).toBeNull();
    expect(buttons()).toEqual(['Save as preset…']);
  });

  it('tells when the treatments changed, to update the preset or apply it again', async () => {
    desktop.settings = { ...desktop.settings, presetId: 'tiktok' };
    await create([TIKTOK]);
    expect(options()).toEqual(['No preset', 'TikTok']);
    expect(buttons()).toEqual(['', '', 'Save as new…']);

    settings.updateRecipe({ trimEnd: frames(15) });
    await render();
    expect(options()).toEqual(['No preset', 'TikTok (changed)']);
    expect(summary()).toBe('Sets the trims. Changed since it was applied.');
    expect(buttons()).toEqual(['', '', 'Update', 'Apply again', 'Save as new…']);

    await click('Apply again');
    expect(settings.recipe().trimEnd).toEqual(frames(12));
    expect(options()).toEqual(['No preset', 'TikTok']);

    settings.updateRecipe({ trimEnd: frames(15), audio: 'remove' });
    await render();
    await click('Update the preset TikTok with the treatments');
    // Only the sections it sets.
    expect(desktop.callsTo('savePreset')).toEqual([
      [{ id: 'tiktok', name: 'TikTok', trim: { ...TIKTOK.trim, trimEnd: frames(15) } }],
    ]);
    expect(options()).toEqual(['No preset', 'TikTok']);
  });

  it('renames the current preset', async () => {
    desktop.settings = { ...desktop.settings, presetId: 'tiktok' };
    await create([TIKTOK, BEACH]);
    await click('Rename the preset TikTok');
    expect(nameInput().value).toBe('TikTok');
    expect(document.activeElement).toBe(nameInput());
    await typeName('Beach Music');
    await submit();
    expect(error()).toBe('A preset is already named “beach music”.');
    // Its own name, in another case, is fine.
    await typeName('TIKTOK');
    await submit();
    expect(options()).toEqual(['No preset', 'beach music', 'TIKTOK']);
    expect(document.activeElement).toBe(menu());
  });

  it('deletes the current preset once confirmed, leaving the treatments', async () => {
    desktop.settings = { ...desktop.settings, presetId: 'tiktok' };
    await create([TIKTOK, BEACH]);
    await click('Delete the preset TikTok');
    expect(text(host.querySelector('[role="alertdialog"]'))).toBe(
      'Delete the preset “TikTok”? The treatments stay as they are. Cancel Delete',
    );
    expect(document.activeElement).toBe(button('Cancel'));
    await submit();
    expect(desktop.callsTo('removePreset')).toEqual([['tiktok']]);
    expect(options()).toEqual(['No preset', 'beach music']);
    expect(settings.presetId()).toBeNull();
    expect(settings.recipe().trimEnd).toEqual(frames(12));
    expect(document.activeElement).toBe(button('Save as preset…'));
  });

  it('cancels with Escape, giving the focus back to what opened the form', async () => {
    desktop.settings = { ...desktop.settings, presetId: 'tiktok' };
    await create([TIKTOK]);
    await click('Delete the preset TikTok');
    host
      .querySelector('form')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await render();
    expect(desktop.callsTo('removePreset')).toEqual([]);
    expect(document.activeElement).toBe(button('Delete the preset TikTok'));

    await click('Save as new…');
    await click('Cancel');
    expect(document.activeElement).toBe(button('Save as new…'));
  });

  it('warns when the soundtrack of the current preset left the audio list', async () => {
    desktop.settings = {
      recipe: { ...DEFAULT_RECIPE, audio: 'replace', trackId: 'waves' },
      output: { location: 'folder', folder: 'D:\\Reels' },
      presetId: 'beach',
    };
    await create([BEACH]);
    expect(summary()).toBe('Sets the audio and where to save.');
    desktop.emitTracks([]);
    await render();
    expect(summary()).toBe(
      'Sets the audio and where to save. Its soundtrack is no longer in the audio list.',
    );
  });
});
