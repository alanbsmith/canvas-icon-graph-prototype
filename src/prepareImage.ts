// This file turns a raw SVG icon (text) into a PNG image (pixels) that we
// can send to the vision model. There are two steps: "normalize" the SVG's
// colors, then "rasterize" (render) it to a PNG.
//
// We use a library called "sharp" for the image work:
// https://sharp.pixelplumbing.com/

import sharp from 'sharp';

// --------------------------------------------------------------------------
// Step 1: color normalization
// --------------------------------------------------------------------------
// The icons in this package color their shapes using a CSS function called
// `oklch(...)`, e.g. `fill="oklch(0.3523 0 0 / 1)"`. oklch is a fairly new
// way of describing colors (part of "CSS Color Module Level 4"):
// https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/oklch
//
// The problem: several SVG-to-PNG rendering libraries (including sharp's
// underlying renderer) don't reliably understand `oklch(...)` yet, and may
// render the shape as black, invisible, or throw an error.
//
// The fix: since we don't actually care about the EXACT shade of gray for a
// tagging task (the vision model just needs to clearly see the icon's
// shape), we replace every `oklch(...)` value with a plain hex color
// BEFORE handing the SVG to sharp. This sidesteps the compatibility problem
// entirely, regardless of which renderer sharp uses internally.
//
// The regular expression below, explained in plain English:
//   /oklch\([^)]*\)/g
//   - `oklch\(`      matches the literal text "oklch(" (the backslash
//                     "escapes" the parenthesis, since ( normally has a
//                     special meaning in regex)
//   - `[^)]*`        matches any run of characters that are NOT a closing
//                     parenthesis (this is "everything inside the
//                     parentheses", e.g. "0.3523 0 0 / 1")
//   - `\)`           matches the literal closing parenthesis
//   - the trailing `g` flag means "replace ALL matches in the string", not
//     just the first one (a single icon can have multiple oklch(...) fills)
// Reference on regex syntax: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions
const OKLCH_COLOR_PATTERN = /oklch\([^)]*\)/g;

// An arbitrary dark, neutral gray. The exact value doesn't matter for this
// project -- we just need something clearly visible against a white
// background.
const NORMALIZED_ICON_COLOR = '#1a1a1a';

/** Replaces every oklch(...) color in the SVG's source text with a plain hex color. */
export function normalizeSvg(rawSvg: string): string {
  return rawSvg.replace(OKLCH_COLOR_PATTERN, NORMALIZED_ICON_COLOR);
}

// --------------------------------------------------------------------------
// Step 2: rasterization (SVG text -> PNG pixels)
// --------------------------------------------------------------------------

// Every icon's original SVG has a 24x24 viewBox (i.e. it's designed at
// 24x24 "units"). We need this number to calculate how much to "zoom in"
// when rendering at a larger size -- see the density calculation below.
const SOURCE_VIEWBOX_SIZE = 24;

// sharp's default rendering resolution for SVGs is 72 DPI (dots per inch),
// which is fine for a 24x24 source, but produces a blurry result if we then
// just stretch/upscale that tiny raster to something bigger. Instead, we
// tell sharp to render at a HIGHER density up front, proportional to how
// much bigger our target size is than the source -- this way it draws
// crisp lines at the final resolution instead of blowing up a blurry image.
// (This "density" option is documented at https://sharp.pixelplumbing.com/api-constructor)
const DEFAULT_RENDER_DPI = 72;

/**
 * Renders a (color-normalized) SVG icon to a square PNG image, sized for a
 * vision model to inspect clearly.
 *
 * @param normalizedSvg - SVG source text that has already been through
 *   `normalizeSvg()` above (no oklch colors left in it).
 * @param outputSize - width and height (in pixels) of the final PNG.
 *   Defaults to 512, which is large enough for a 7-billion-parameter vision
 *   model to make out the icon's details clearly, without making the
 *   request payload unnecessarily large.
 */
export async function rasterizeSvgToPng(
  normalizedSvg: string,
  outputSize = 512,
): Promise<Buffer> {
  const density = Math.round(DEFAULT_RENDER_DPI * (outputSize / SOURCE_VIEWBOX_SIZE));

  return sharp(Buffer.from(normalizedSvg), { density })
    // `fit: 'contain'` scales the icon to fit inside outputSize x outputSize
    // without cropping or distorting it; any leftover space is filled with
    // the `background` color.
    .resize(outputSize, outputSize, { fit: 'contain', background: '#ffffff' })
    // The icon's own background is transparent. `.flatten()` paints a solid
    // color BEHIND the transparent areas, so the final PNG has a plain
    // white background instead of transparency (which some image viewers/
    // models render as black, causing the icon to look invisible).
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
}
