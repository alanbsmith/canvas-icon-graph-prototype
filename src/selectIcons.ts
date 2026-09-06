// This file decides WHICH icons a run processes. There are two options:
//   - selectIconSample(): a small, representative sample (~18 icons) used
//     to validate tagging quality quickly and cheaply.
//   - selectAllIcons(): every active icon, used for a full production run
//     once the sample has proven the approach works.
//
// The sample selection is DETERMINISTIC -- meaning if you run it twice,
// you get the exact same 18 icons both times. There's no randomness (no
// Math.random(), no shuffling). This matters because while we're tuning the
// prompt in ollamaClient.ts, we want to compare "attempt 2" against
// "attempt 1" on the exact same icons, otherwise we can't tell whether a
// quality change came from the prompt or just from picking different icons.

import type { IconMetadataEntry } from './types.ts';

// The 11 categories that exist in the current package version, in a fixed
// order (this doesn't need to match any particular order in the source
// data -- we just need SOME fixed order so results are reproducible).
export const CATEGORY_ORDER = [
  'Core',
  'Objects',
  'Editor',
  'Navigation',
  'Files & Docs',
  'Chart Visuals',
  'Audio Visual',
  'Data Stream',
  'People',
  'Notification',
  'Mobile App',
] as const;

// These are the 7 largest categories (most icons). We pick 2 icons from
// each of these (for a bit more visual variety) and 1 icon from each of the
// remaining 4 smaller categories. That works out to 7*2 + 4*1 = 18 icons
// total, while still covering every category at least once.
const DOUBLE_PICK_CATEGORIES = new Set<string>([
  'Core',
  'Objects',
  'Editor',
  'Navigation',
  'Files & Docs',
  'Chart Visuals',
  'Audio Visual',
]);

/**
 * Picks a deterministic sample of icons spread across every category.
 *
 * How it works, step by step:
 *   1. Group all icons by their `category` field.
 *   2. Within each category's group, sort icons alphabetically by name
 *      (this is what makes "icon #1" and "icon #2" of a category always be
 *      the SAME icons on every run).
 *   3. Take the first icon from every category.
 *   4. For the 7 largest categories, also take the icon in the exact
 *      middle of that category's (sorted) list, so the two picks from a
 *      category aren't right next to each other alphabetically.
 */
export function selectIconSample(allIcons: IconMetadataEntry[]): IconMetadataEntry[] {
  const byCategory = new Map<string, IconMetadataEntry[]>();
  for (const icon of allIcons) {
    const list = byCategory.get(icon.category) ?? [];
    list.push(icon);
    byCategory.set(icon.category, list);
  }

  const selected: IconMetadataEntry[] = [];

  for (const category of CATEGORY_ORDER) {
    const iconsInCategory = (byCategory.get(category) ?? [])
      .slice() // copy the array so `.sort()` below doesn't mutate the shared map
      .sort((a, b) => a.name.localeCompare(b.name));

    if (iconsInCategory.length === 0) {
      continue; // shouldn't happen with the current package, but don't crash if a category is empty
    }

    selected.push(iconsInCategory[0]);

    if (DOUBLE_PICK_CATEGORIES.has(category) && iconsInCategory.length > 1) {
      const middleIndex = Math.floor(iconsInCategory.length / 2);
      selected.push(iconsInCategory[middleIndex]);
    }
  }

  return selected;
}

/**
 * Returns every active icon, sorted alphabetically by name.
 *
 * This is the "full run" counterpart to selectIconSample() above -- used
 * once tagging quality has been validated on the small sample and it's
 * time to process the whole active icon set. Sorting isn't required for
 * correctness here (run.ts tracks progress by icon NAME, not by position,
 * so a run can be safely stopped and resumed in any order), but a stable,
 * predictable order makes the console progress log easier to follow and
 * compare between runs.
 */
export function selectAllIcons(allIcons: IconMetadataEntry[]): IconMetadataEntry[] {
  return allIcons.slice().sort((a, b) => a.name.localeCompare(b.name));
}
