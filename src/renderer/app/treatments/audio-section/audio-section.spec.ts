import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { DEFAULT_RECIPE, DEFAULT_SETTINGS } from '@shared/model';
import type { MockInstance } from 'vitest';
import { DESKTOP } from '../../core/desktop';
import { SettingsStore } from '../../core/settings-store';
import { audioTrack, FakeDesktop, settle, text } from '../../testing/fake-desktop';
import { AudioSection } from './audio-section';

describe('AudioSection', () => {
  let desktop: FakeDesktop;
  let settings: SettingsStore;
  let fixture: ComponentFixture<AudioSection>;
  let host: HTMLElement;
  let play: MockInstance<HTMLMediaElement['play']>;
  let pause: MockInstance<HTMLMediaElement['pause']>;

  beforeEach(async () => {
    // Not implemented by jsdom.
    play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);

    desktop = new FakeDesktop();
    desktop.settings = {
      ...DEFAULT_SETTINGS,
      recipe: { ...DEFAULT_RECIPE, audio: 'replace', trackId: 'b' },
    };
    desktop.tracks = [
      audioTrack('a'),
      audioTrack('b', { durationSec: 3725 }),
      audioTrack('c', { status: 'missing', durationSec: null }),
      audioTrack('d', { status: 'probing', durationSec: null }),
    ];
    TestBed.configureTestingModule({ providers: [{ provide: DESKTOP, useValue: desktop }] });
    settings = TestBed.inject(SettingsStore);
    await settings.load();
    fixture = TestBed.createComponent(AudioSection);
    host = fixture.nativeElement as HTMLElement;
    document.body.append(host);
    await render();
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  async function render(): Promise<void> {
    await settle();
    await fixture.whenStable();
  }

  const radios = (): HTMLInputElement[] => [
    ...host.querySelectorAll<HTMLInputElement>('input[name="track"]'),
  ];
  const button = (label: string): HTMLButtonElement | null =>
    host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const status = (): string => text(host.querySelector('app-track-list [role="status"]'));
  const undecodable = (): Promise<void> =>
    Promise.reject(new DOMException('No decoder', 'NotSupportedError'));
  const suffixFields = (): HTMLInputElement[] => [
    ...host.querySelectorAll<HTMLInputElement>('.suffix input'),
  ];
  /** Types `value` in the suffix field, then presses `key` or leaves the field. */
  const typeSuffix = async (value: string, key?: 'Enter' | 'Escape'): Promise<void> => {
    const field = suffixFields()[0]!;
    field.value = value;
    field.dispatchEvent(new Event('input'));
    field.dispatchEvent(
      key === undefined ? new Event('blur') : new KeyboardEvent('keydown', { key, bubbles: true }),
    );
    await render();
  };
  const mode = async (value: string): Promise<void> => {
    host.querySelector<HTMLInputElement>(`input[name="audio-mode"][value="${value}"]`)?.click();
    await render();
  };

  it('offers to keep, remove or replace the audio, as radio buttons', async () => {
    const options = [...host.querySelectorAll<HTMLInputElement>('input[name="audio-mode"]')];
    expect(options.map((option) => text(option.closest('label')))).toEqual([
      'Keep',
      'Remove',
      'Replace',
    ]);
    expect(options.map((option) => option.checked)).toEqual([false, false, true]);
    await mode('keep');
    expect(settings.recipe().audio).toBe('keep');
    expect(host.querySelector('app-track-list')).toBeNull();
  });

  it('lists the audio files with their length or what is wrong with them', () => {
    expect(radios().map((radio) => text(host.querySelector(`label[for="${radio.id}"]`)))).toEqual([
      'a.mp3 1:35',
      'b.mp3 1:02:05',
      'c.mp3 Missing',
      'd.mp3 Reading…',
    ]);
    expect(radios().map((radio) => radio.checked)).toEqual([false, true, false, false]);
    expect(button('Play c.mp3')?.disabled).toBe(true);
    expect(button('Play d.mp3')?.disabled).toBe(false);
  });

  it('shows the suffix of the audio file chosen, under it', async () => {
    expect(suffixFields()).toHaveLength(1);
    const field = suffixFields()[0]!;
    expect(field.value).toBe('b');
    expect(field.placeholder).toBe('b');
    expect(field.closest('li')?.classList).toContain('selected');
    expect(text(host.querySelector(`label[for="${field.id}"]`))).toBe('Suffix');
    expect(text(host.querySelector(`#${field.getAttribute('aria-describedby') ?? ''}`))).toBe(
      'Added to the names of the results. Left empty, the file name is used.',
    );
    radios()[0]?.click();
    await render();
    expect(suffixFields().map((input) => input.value)).toEqual(['a']);
  });

  it('saves the suffix typed, as the main process keeps it', async () => {
    await typeSuffix(' Plage 🌊 ');
    expect(desktop.callsTo('setTrackSuffix')).toEqual([['b', ' Plage 🌊 ']]);
    expect(suffixFields()[0]?.value).toBe('Plage 🌊');
    expect(desktop.tracks[1]?.suffix).toBe('Plage 🌊');

    await typeSuffix('Vagues', 'Enter');
    expect(desktop.callsTo('setTrackSuffix').at(-1)).toEqual(['b', 'Vagues']);
    expect(suffixFields()[0]?.value).toBe('Vagues');

    // Nothing typed: the file name.
    await typeSuffix('');
    expect(desktop.callsTo('setTrackSuffix').at(-1)).toEqual(['b', '']);
    expect(suffixFields()[0]?.value).toBe('b');
  });

  it('saves nothing when the suffix is unchanged, or given up with Escape', async () => {
    await typeSuffix('b');
    await typeSuffix('oops', 'Escape');
    expect(suffixFields()[0]?.value).toBe('b');
    await typeSuffix('b');
    expect(desktop.callsTo('setTrackSuffix')).toEqual([]);
  });

  it('says when a suffix cannot be changed, and shows the one kept', async () => {
    desktop.respond('setTrackSuffix', () =>
      Promise.reject(new Error('The data folder is locked.')),
    );
    await typeSuffix('Plage');
    expect(status()).toBe('Cannot change the suffix of b.mp3: The data folder is locked.');
    expect(suffixFields()[0]?.value).toBe('b');
  });

  it('uses the audio file chosen', async () => {
    radios()[0]?.click();
    await render();
    expect(settings.recipe().trackId).toBe('a');
  });

  it('forgets a removed audio file, and no longer uses it', async () => {
    button('Remove b.mp3 from the audio list')?.click();
    await render();
    expect(desktop.callsTo('removeTrack')).toEqual([['b']]);
    expect(settings.recipe().trackId).toBeNull();
  });

  it('previews one audio file at a time, and stops when the list hides', async () => {
    const audio = host.querySelector('audio') as HTMLAudioElement;
    button('Play a.mp3')?.click();
    await render();
    expect(audio.getAttribute('src')).toBe('track://audio/a');
    expect(play).toHaveBeenCalledTimes(1);
    expect(button('Pause a.mp3')).not.toBeNull();

    button('Play b.mp3')?.click();
    await render();
    expect(audio.getAttribute('src')).toBe('track://audio/b');
    expect(button('Play a.mp3')).not.toBeNull();

    button('Pause b.mp3')?.click();
    await render();
    expect(pause).toHaveBeenCalled();
    expect(button('Play b.mp3')).not.toBeNull();

    button('Play a.mp3')?.click();
    await render();
    pause.mockClear();
    await mode('remove');
    expect(pause).toHaveBeenCalled();
  });

  it('stops the preview of an audio file removed from the list', async () => {
    button('Play a.mp3')?.click();
    await render();
    desktop.emitTracks(desktop.tracks.filter((track) => track.id !== 'a'));
    await render();
    expect(pause).toHaveBeenCalled();
    expect(host.querySelector('button[aria-label^="Pause"]')).toBeNull();
  });

  it('says when an audio file cannot be played', async () => {
    play.mockImplementation(undecodable);
    button('Play a.mp3')?.click();
    await render();
    expect(status()).toBe('Cannot play a.mp3.');
    expect(button('Play a.mp3')).not.toBeNull();
  });

  it('lets a newer message replace the one about a preview that could not play', async () => {
    play.mockImplementation(undecodable);
    button('Play a.mp3')?.click();
    await render();
    desktop.respond('chooseTracks', () =>
      Promise.resolve({ added: 0, duplicates: 0, ignored: 1, truncated: false }),
    );
    host.querySelector<HTMLButtonElement>('.add')?.click();
    await render();
    expect(status()).toBe('1 file ignored: not audio');

    desktop.respond('removeTrack', () => Promise.reject(new Error('The data folder is locked.')));
    button('Play b.mp3')?.click();
    await render();
    expect(status()).toBe('Cannot play b.mp3.');
    button('Remove d.mp3 from the audio list')?.click();
    await render();
    expect(status()).toBe('Cannot remove d.mp3: The data folder is locked.');
  });

  it('forgets why a preview could not play once another one is tried, or the file removed', async () => {
    play.mockImplementationOnce(undecodable);
    button('Play a.mp3')?.click();
    await render();
    button('Play b.mp3')?.click();
    await render();
    expect(status()).toBe('');

    play.mockImplementationOnce(undecodable);
    button('Play a.mp3')?.click();
    await render();
    button('Remove c.mp3 from the audio list')?.click();
    await render();
    expect(status()).toBe('Cannot play a.mp3.');
    button('Remove a.mp3 from the audio list')?.click();
    await render();
    expect(status()).toBe('');
  });

  it('uses the first audio file added while none is chosen', async () => {
    settings.updateRecipe({ trackId: null });
    desktop.respond('chooseTracks', () => {
      desktop.emitTracks([...desktop.tracks, audioTrack('new')]);
      return Promise.resolve({ added: 1, duplicates: 0, ignored: 0, truncated: false });
    });
    host.querySelector<HTMLButtonElement>('.add')?.click();
    await render();
    expect(settings.recipe().trackId).toBe('new');
    expect(text(host.querySelector('app-track-list [role="status"]'))).toBe('1 audio file added');
  });

  it('suggests adding audio files to an empty list', async () => {
    desktop.emitTracks([]);
    await render();
    expect(text(host.querySelector('.empty'))).toBe(
      'No audio files yet. Add some, or drop them here.',
    );
  });

  it('loops the audio, or not', async () => {
    const loop = host.querySelector<HTMLInputElement>('#audio-loop');
    expect(loop?.checked).toBe(true);
    expect(text(host.querySelector(`#${loop?.getAttribute('aria-describedby') ?? ''}`))).toBe(
      'Otherwise silence fills the rest. Longer audio is cut at the end of the video.',
    );
    loop?.click();
    await render();
    expect(settings.recipe().loop).toBe(false);
  });
});
