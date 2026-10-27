/**
 * Presets as both sides see them: what one holds, how it applies to the treatments, and whether
 * the treatments still are what it sets. The renderer checks a preset before saving it, and the
 * main process refuses the same cases.
 */
import type { OutputSettings, Preset, PresetSection, PresetValues, Recipe, Trim } from './model';
import { DEFAULT_RECIPE, PRESET_SECTIONS } from './model';
import { trims } from './recipe';

/** Longest name kept, in characters: presets are picked from a menu, in a narrow panel. */
export const PRESET_NAME_MAX_LENGTH = 60;

/**
 * A name as typed, cleaned up: white space collapsed to single spaces and trimmed, at most
 * `PRESET_NAME_MAX_LENGTH` characters as people count them (an emoji is one). Empty when nothing is
 * left.
 */
export function presetName(text: string): string {
  const name = text.normalize('NFC').replace(/\s+/gu, ' ').trim();
  const characters = [...new Intl.Segmenter().segment(name)].map(({ segment }) => segment);
  return characters.slice(0, PRESET_NAME_MAX_LENGTH).join('').trim();
}

/** Identity of a name: names that differ only in case or spacing are the same. */
export function presetKey(name: string): string {
  return presetName(name).toLowerCase();
}

/** The sections a preset sets, in the order of the panel. */
export function presetSections(values: PresetValues): PresetSection[] {
  return PRESET_SECTIONS.filter((section) => values[section] !== undefined);
}

/**
 * The treatments of the given sections, to save as a preset. Only a replaced audio keeps its
 * soundtrack and loop, and only a folder location its folder: the others do not use them.
 */
export function presetValues(
  recipe: Recipe,
  output: OutputSettings,
  sections: readonly PresetSection[],
): PresetValues {
  const { audio, trackId, loop, silenceStart, silenceEnd, trimStart, trimEnd, precision } = recipe;
  const replaced = audio === 'replace';
  return {
    ...(sections.includes('audio')
      ? {
          audio: {
            audio,
            trackId: replaced ? trackId : null,
            loop: replaced ? loop : DEFAULT_RECIPE.loop,
          },
        }
      : {}),
    ...(sections.includes('silence') ? { silence: { silenceStart, silenceEnd } } : {}),
    ...(sections.includes('trim') ? { trim: { trimStart, trimEnd, precision } } : {}),
    ...(sections.includes('output')
      ? {
          output:
            output.location === 'folder' ? output : { location: output.location, folder: null },
        }
      : {}),
  };
}

export interface Treatments {
  readonly recipe: Recipe;
  readonly output: OutputSettings;
}

/**
 * The treatments once `preset` is applied: the sections it sets take its values, the others stay.
 * Choosing to keep or remove the audio leaves the soundtrack chosen for when it is replaced, and
 * saving next to the videos leaves the folder chosen for when they go in one.
 */
export function applyPreset(preset: PresetValues, { recipe, output }: Treatments): Treatments {
  const audio =
    preset.audio === undefined || preset.audio.audio === 'replace'
      ? (preset.audio ?? {})
      : { audio: preset.audio.audio };
  return {
    recipe: { ...recipe, ...audio, ...preset.silence, ...preset.trim },
    output:
      preset.output === undefined || preset.output.location === 'folder'
        ? (preset.output ?? output)
        : { ...output, location: preset.output.location },
  };
}

/**
 * Whether the treatments still are what `preset` sets, in each section it sets. Only what makes a
 * difference counts: a unit with nothing in it, the precision without trims, the soundtrack of an
 * audio kept or removed, the folder when saving next to the videos.
 */
export function presetMatches(preset: PresetValues, treatments: Treatments): boolean {
  return sameTreatments(applyPreset(preset, treatments), treatments);
}

/** Whether two sets of treatments give the same results. */
export function sameTreatments(a: Treatments, b: Treatments): boolean {
  const ra = a.recipe;
  const rb = b.recipe;
  return (
    ra.audio === rb.audio &&
    (ra.audio !== 'replace' || (ra.trackId === rb.trackId && ra.loop === rb.loop)) &&
    sameLength(ra.silenceStart, rb.silenceStart) &&
    sameLength(ra.silenceEnd, rb.silenceEnd) &&
    sameLength(ra.trimStart, rb.trimStart) &&
    sameLength(ra.trimEnd, rb.trimEnd) &&
    (!trims(ra) || ra.precision === rb.precision) &&
    a.output.location === b.output.location &&
    (a.output.location !== 'folder' || a.output.folder === b.output.folder)
  );
}

function sameLength(a: Trim, b: Trim): boolean {
  return a.amount === b.amount && (a.amount === 0 || a.unit === b.unit);
}

/**
 * Why a preset cannot be saved, in words for the user; `null` when it can. `presets` are those
 * saved already; `id` is the preset's own, when it is a new version of one.
 */
export function presetIssue(
  draft: PresetValues & { readonly name: string },
  presets: readonly Preset[],
  id?: string,
): string | null {
  const key = presetKey(draft.name);
  if (key === '') {
    return 'Name the preset.';
  }
  const taken = presets.find((preset) => preset.id !== id && presetKey(preset.name) === key);
  if (taken !== undefined) {
    return `A preset is already named “${taken.name}”.`;
  }
  return presetSections(draft).length === 0 ? 'Choose what the preset sets.' : null;
}

/** Presets by name, as a menu lists them: numbers in order ("Clip 2" before "Clip 10"). */
export function byName(a: Preset, b: Preset): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}
