import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import type { Preset } from '@shared/model';
import { DEFAULT_RECIPE, DEFAULT_SETTINGS } from '@shared/model';
import { DESKTOP } from '../../core/desktop';
import { SettingsStore } from '../../core/settings-store';
import { TracksStore } from '../../core/tracks-store';
import { audioTrack, FakeDesktop, settle, text } from '../../testing/fake-desktop';
import { PresetSection } from './preset-section';

const seconds = (amount: number) => ({ amount, unit: 'seconds' }) as const;
const frames = (amount: number) => ({ amount, unit: 'frames' }) as const;

const TRIM = { trimStart: seconds(0), trimEnd: frames(12), precision: 'exact' } as const;
const TIKTOK: Preset = { id: 'tiktok', name: 'TikTok', trim: TRIM };
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
    // Lists the audio files, as the panel does.
    TestBed.inject(TracksStore);
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

  const presetButtons = (): HTMLButtonElement[] => [
    ...host.querySelectorAll<HTMLButtonElement>('button.preset'),
  ];
  const presetNames = (): string[] => presetButtons().map((button) => text(button));
  const currentName = (): string => text(host.querySelector('button.preset[aria-current="true"]'));
  const buttons = (): string[] =>
    [...host.querySelectorAll('.buttons button')].map(
      (button) => button.getAttribute('aria-label') ?? text(button),
    );
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
  const error = (): Element | null => host.querySelector('[role="alert"].error-text');
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
  const ticked = (): string[] =>
    ['Audio', 'Silence', 'Trim', 'Save to'].filter((label) => checkbox(label).checked);
  const submit = async (): Promise<void> => {
    host.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await render();
  };

  it('offers to save the treatments while there is no preset yet', async () => {
    await create([]);
    expect(presetButtons()).toEqual([]);
    expect(text(host.querySelector('.hint'))).toBe(
      'Save the treatments as a preset, to set them again in one go.',
    );
    expect(buttons()).toEqual(['Save as preset…']);
  });

  it('saves the sections chosen as a new preset, which becomes the current one', async () => {
    await create([]);
    await click('Save as preset…');
    expect(document.activeElement).toBe(nameInput());
    // Each says what it would keep.
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
    // What the treatments use is ticked: not an audio kept as it is, nor where to save.
    expect(ticked()).toEqual(['Silence', 'Trim']);

    await typeName('  TikTok ');
    checkbox('Silence').click();
    await render();
    await submit();

    expect(desktop.callsTo('savePreset')).toEqual([[{ name: '  TikTok ', trim: TRIM }]]);
    expect(presetNames()).toEqual(['TikTok']);
    expect(currentName()).toBe('TikTok');
    expect(document.activeElement).toBe(presetButtons()[0]);
    expect(summary()).toBe('TikTok sets the trims.');
    expect(desktop.settings.presetId).toBe('preset-1');
  });

  it('ticks the sections of the current preset to save a new one', async () => {
    desktop.settings = {
      recipe: { ...DEFAULT_RECIPE, audio: 'replace', trackId: 'waves' },
      output: { location: 'folder', folder: 'D:\\Reels' },
      presetId: 'beach',
    };
    await create([BEACH]);
    await click('Save as new…');
    expect(ticked()).toEqual(['Audio', 'Save to']);
  });

  it('says why a preset cannot be saved, each time, and keeps the form open', async () => {
    await create([TIKTOK]);
    await click('Save as preset…');
    await submit();
    const first = error();
    expect(text(first)).toBe('Name the preset.');
    expect(nameInput().getAttribute('aria-invalid')).toBe('true');
    expect(nameInput().getAttribute('aria-describedby')).toBe(first?.id);
    // The same message again is a new one, announced again.
    await submit();
    expect(text(error())).toBe('Name the preset.');
    expect(error()).not.toBe(first);

    await typeName('tiktok');
    await submit();
    expect(text(error())).toBe('A preset is already named “TikTok”.');
    await typeName('x'.repeat(61));
    await submit();
    expect(text(error())).toBe('Use at most 60 characters for the name.');
    await typeName('Reels');
    checkbox('Trim').click();
    checkbox('Silence').click();
    await render();
    await submit();
    expect(text(error())).toBe('Choose what the preset sets.');
    expect(desktop.callsTo('savePreset')).toEqual([]);

    // The main process may refuse it too.
    desktop.respond('savePreset', () =>
      Promise.reject(new Error("Error invoking remote method 'presets:save': Error: Disk full.")),
    );
    checkbox('Trim').click();
    await render();
    await submit();
    expect(text(error())).toBe('Disk full.');
    expect(nameInput()).not.toBeNull();
  });

  it('applies the preset clicked, to the sections it sets only', async () => {
    await create([TIKTOK, BEACH]);
    expect(presetNames()).toEqual(['beach music', 'TikTok']);
    expect(currentName()).toBe('');
    expect(summary()).toBe('Choose one to set the treatments it holds.');

    await click('beach music');
    expect(settings.recipe()).toMatchObject({
      audio: 'replace',
      trackId: 'waves',
      trimEnd: frames(12),
      silenceEnd: seconds(1),
    });
    expect(settings.output()).toEqual({ location: 'folder', folder: 'D:\\Reels' });
    expect(currentName()).toBe('beach music');
    expect(summary()).toBe('beach music sets the audio and where to save.');
    expect(desktop.settings.presetId).toBe('beach');
  });

  it('tells when the treatments changed, to update the preset or apply it again', async () => {
    desktop.settings = { ...desktop.settings, presetId: 'tiktok' };
    await create([TIKTOK]);
    expect(buttons()).toEqual(['Save as new…', 'Rename TikTok', 'Delete TikTok']);

    settings.updateRecipe({ trimEnd: frames(15) });
    await render();
    expect(currentName()).toBe('TikTok (changed)');
    expect(summary()).toBe('TikTok sets the trims. Changed since it was applied.');
    expect(buttons()).toEqual([
      'Update',
      'Apply again',
      'Save as new…',
      'Rename TikTok',
      'Delete TikTok',
    ]);
    expect(button('Apply again').getAttribute('aria-describedby')).toBe('preset-summary');

    await click('Apply again');
    expect(settings.recipe().trimEnd).toEqual(frames(12));
    expect(currentName()).toBe('TikTok');
    // Apply again went away with the change: the focus is on the preset.
    expect(document.activeElement).toBe(presetButtons()[0]);

    settings.updateRecipe({ trimEnd: frames(15), audio: 'remove' });
    await render();
    await click('Update');
    // Only the sections it sets.
    expect(desktop.callsTo('savePreset')).toEqual([
      [{ id: 'tiktok', name: 'TikTok', trim: { ...TRIM, trimEnd: frames(15) } }],
    ]);
    expect(currentName()).toBe('TikTok');
    expect(document.activeElement).toBe(presetButtons()[0]);
  });

  it('applies the lengths again over text that was not one', async () => {
    desktop.settings = { ...desktop.settings, presetId: 'tiktok' };
    await create([TIKTOK]);
    const before = settings.recipe().trimEnd;
    await click('TikTok');
    // A new value, though the same length: a field holding other text shows it again.
    expect(settings.recipe().trimEnd).toEqual(before);
    expect(settings.recipe().trimEnd).not.toBe(before);
  });

  it('renames the current preset', async () => {
    desktop.settings = { ...desktop.settings, presetId: 'tiktok' };
    await create([TIKTOK, BEACH]);
    await click('Rename TikTok');
    expect(nameInput().value).toBe('TikTok');
    expect(document.activeElement).toBe(nameInput());
    await typeName('Beach Music');
    await submit();
    expect(text(error())).toBe('A preset is already named “beach music”.');
    // Its own name, in another case, is fine.
    await typeName('TIKTOK');
    await submit();
    expect(presetNames()).toEqual(['beach music', 'TIKTOK']);
    expect(document.activeElement).toBe(presetButtons()[1]);
  });

  it('deletes the current preset once confirmed, leaving the treatments', async () => {
    desktop.settings = { ...desktop.settings, presetId: 'tiktok' };
    await create([TIKTOK, BEACH]);
    await click('Delete TikTok');
    expect(text(host.querySelector('[role="alertdialog"]'))).toBe(
      'Delete the preset “TikTok”? The treatments stay as they are. Cancel Delete',
    );
    expect(document.activeElement).toBe(button('Cancel'));
    await submit();
    expect(desktop.callsTo('removePreset')).toEqual([['tiktok']]);
    expect(presetNames()).toEqual(['beach music']);
    expect(settings.presetId()).toBeNull();
    expect(settings.recipe().trimEnd).toEqual(frames(12));
    expect(document.activeElement).toBe(button('Save as preset…'));
  });

  it('cancels with Escape, giving the focus back to what opened the form', async () => {
    desktop.settings = { ...desktop.settings, presetId: 'tiktok' };
    await create([TIKTOK]);
    await click('Delete TikTok');
    host
      .querySelector('form')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await render();
    expect(desktop.callsTo('removePreset')).toEqual([]);
    expect(document.activeElement).toBe(button('Delete TikTok'));

    await click('Save as new…');
    await click('Cancel');
    expect(document.activeElement).toBe(button('Save as new…'));
  });

  describe('with a soundtrack no longer in the audio list', () => {
    beforeEach(() => {
      desktop.settings = {
        recipe: { ...DEFAULT_RECIPE, audio: 'replace', trackId: 'waves' },
        output: { location: 'folder', folder: 'D:\\Reels' },
        presetId: 'beach',
      };
    });

    it('says so, and how to set another one', async () => {
      await create([BEACH]);
      expect(summary()).toBe('beach music sets the audio and where to save.');
      desktop.emitTracks([]);
      await render();
      expect(summary()).toBe(
        'beach music sets the audio and where to save. Changed since it was applied. Its soundtrack is not in the audio list: choose one, then update the preset.',
      );
    });

    it('applies it without that soundtrack, as the treatments are saved', async () => {
      desktop.tracks = [audioTrack('other')];
      await create([BEACH]);
      expect(currentName()).toBe('beach music (changed)');
      presetButtons()[0]?.click();
      await render();
      expect(settings.recipe()).toMatchObject({ audio: 'replace', trackId: null });
      expect(currentName()).toBe('beach music');
      await settings.flush();
      expect(desktop.settings.recipe.trackId).toBeNull();

      // Another soundtrack chosen: the preset can be updated with it.
      settings.updateRecipe({ trackId: 'other' });
      await render();
      expect(currentName()).toBe('beach music (changed)');
      await click('Update');
      expect(desktop.callsTo('savePreset')).toEqual([
        [{ ...BEACH, audio: { audio: 'replace', trackId: 'other', loop: true } }],
      ]);
      expect(summary()).toBe('beach music sets the audio and where to save.');
    });
  });
});
