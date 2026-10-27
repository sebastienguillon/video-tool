import type { Preset, PresetDraft } from '@shared/model';
import { presetIssue, presetName } from '@shared/preset';
import { sanitizePresetValues } from './settings-store';

/**
 * The presets once `draft` is saved: a new one at the end, with `newId`, or the new version of
 * the one with its id, where it was. Returns the preset as saved, its name cleaned up and its
 * values as the settings file keeps them. Throws, with a message for the user, for a preset that
 * `presetIssue` refuses, or the new version of one no longer listed.
 */
export function withPreset(
  presets: readonly Preset[],
  draft: PresetDraft,
  newId: string,
): { readonly presets: readonly Preset[]; readonly preset: Preset } {
  const issue = presetIssue(draft, presets, draft.id);
  if (issue !== null) {
    throw new Error(issue);
  }
  const { id = newId, name } = draft;
  const preset: Preset = { id, name: presetName(name), ...sanitizePresetValues(draft) };
  if (draft.id === undefined) {
    return { presets: [...presets, preset], preset };
  }
  if (!presets.some((candidate) => candidate.id === id)) {
    throw new Error(`The preset “${preset.name}” was deleted.`);
  }
  return {
    presets: presets.map((candidate) => (candidate.id === id ? preset : candidate)),
    preset,
  };
}

/** The presets without the one with `id`; the same list when there is none. */
export function withoutPreset(presets: readonly Preset[], id: string): readonly Preset[] {
  const next = presets.filter((preset) => preset.id !== id);
  return next.length === presets.length ? presets : next;
}
