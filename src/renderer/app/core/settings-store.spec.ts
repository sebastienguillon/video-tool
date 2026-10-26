import { TestBed } from '@angular/core/testing';
import type { Recipe, Settings } from '@shared/model';
import { DEFAULT_RECIPE, DEFAULT_SETTINGS } from '@shared/model';
import { FakeDesktop, settle } from '../testing/fake-desktop';
import { DESKTOP } from './desktop';
import { SettingsStore } from './settings-store';

const stored: Settings = {
  recipe: { ...DEFAULT_RECIPE, audio: 'replace', trackId: 't1', loop: false },
  output: { location: 'folder', folder: 'D:\\Exports\\été' },
};

describe('SettingsStore', () => {
  let desktop: FakeDesktop;
  let store: SettingsStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    desktop = new FakeDesktop();
    desktop.settings = stored;
    TestBed.configureTestingModule({ providers: [{ provide: DESKTOP, useValue: desktop }] });
    store = TestBed.inject(SettingsStore);
    await store.load();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const savedRecipes = (): Recipe[] =>
    desktop
      .callsTo('updateSettings')
      .map(([patch]) => (patch as Partial<Settings>).recipe)
      .filter((recipe) => recipe !== undefined);

  it('loads the stored treatments and output, without saving them back', () => {
    expect(store.recipe()).toEqual(stored.recipe);
    expect(store.output()).toEqual(stored.output);
    vi.advanceTimersByTime(1_000);
    expect(desktop.callsTo('updateSettings')).toEqual([]);
  });

  it('keeps the defaults when the settings cannot be read', async () => {
    TestBed.resetTestingModule();
    desktop = new FakeDesktop();
    desktop.respond('getSettings', () => Promise.reject(new Error('Unreadable settings.json')));
    TestBed.configureTestingModule({ providers: [{ provide: DESKTOP, useValue: desktop }] });
    store = TestBed.inject(SettingsStore);
    await store.load();
    expect(store.recipe()).toEqual(DEFAULT_SETTINGS.recipe);
  });

  it('saves the treatments once changes pause', () => {
    store.updateRecipe({ trimStart: { amount: 1, unit: 'seconds' } });
    vi.advanceTimersByTime(300);
    store.updateRecipe({ trimStart: { amount: 12, unit: 'seconds' } });
    vi.advanceTimersByTime(399);
    expect(savedRecipes()).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(savedRecipes()).toEqual([
      { ...stored.recipe, trimStart: { amount: 12, unit: 'seconds' } },
    ]);
  });

  it('saves nothing for a change that changes nothing', () => {
    const recipe = store.recipe();
    store.updateRecipe({ audio: 'replace', trimEnd: { amount: 0, unit: 'seconds' } });
    expect(store.recipe()).toBe(recipe);
    vi.advanceTimersByTime(1_000);
    expect(desktop.callsTo('updateSettings')).toEqual([]);
  });

  it('saves a waiting change at once when asked to, and only once', async () => {
    store.updateRecipe({ precision: 'fast' });
    await store.flush();
    expect(savedRecipes()).toEqual([{ ...stored.recipe, precision: 'fast' }]);
    vi.advanceTimersByTime(1_000);
    await store.flush();
    expect(savedRecipes()).toHaveLength(1);
  });

  it('saves a waiting change when the window closes', () => {
    store.updateRecipe({ loop: true });
    window.dispatchEvent(new Event('beforeunload'));
    expect(savedRecipes()).toEqual([{ ...stored.recipe, loop: true }]);
  });

  it('saves the output at once, keeping the folder for later', async () => {
    await store.setLocation('beside');
    expect(desktop.callsTo('updateSettings')).toEqual([
      [{ output: { location: 'beside', folder: 'D:\\Exports\\été' } }],
    ]);
    await store.setLocation('folder');
    expect(store.output()).toEqual(stored.output);
    expect(desktop.callsTo('chooseOutputFolder')).toEqual([]);
  });

  it('asks for a folder to save in when there is none, and stays next to the videos if canceled', async () => {
    await store.setOutput({ location: 'beside', folder: null });
    const dialog = Promise.withResolvers<string | null>();
    desktop.respond('chooseOutputFolder', () => dialog.promise);

    const choosing = store.setLocation('folder');
    expect(store.output().location).toBe('folder');
    dialog.resolve(null);
    await choosing;
    expect(store.output()).toEqual({ location: 'beside', folder: null });
    expect(desktop.callsTo('updateSettings')).toHaveLength(1);
  });

  it('saves in the folder chosen', async () => {
    desktop.respond('chooseOutputFolder', () => Promise.resolve('E:\\日本\\out'));
    expect(await store.chooseOutputFolder()).toBe(true);
    await settle();
    expect(store.output()).toEqual({ location: 'folder', folder: 'E:\\日本\\out' });
    expect(desktop.settings.output).toEqual({ location: 'folder', folder: 'E:\\日本\\out' });
  });

  it('tells when a trim field holds text that is not a length', () => {
    store.setTrimValidity('trimStart', false);
    store.setTrimValidity('trimEnd', false);
    store.setTrimValidity('trimStart', true);
    expect(store.trimInputInvalid()).toBe(true);
    store.setTrimValidity('trimEnd', true);
    expect(store.trimInputInvalid()).toBe(false);
  });
});
