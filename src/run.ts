// This is the entry point that ties everything together.
//
//   npm run tag       -- processes the small ~18-icon sample (fast, for
//                         testing prompt/code changes)
//   npm run tag:all    -- processes every active icon (slow -- this is a
//                         real production run, expect it to take hours)
//
// For each icon it processes, this file:
//   1. reads the icon's raw SVG file
//   2. normalizes its colors and rasterizes it to a PNG (prepareImage.ts)
//   3. sends the PNG + existing metadata to the vision model (ollamaClient.ts)
//   4. records the result
// ...saving progress to output/tags.json and output/report.html after
// EVERY icon (not just at the end) -- see "Why we save after every icon"
// below for why that matters for the full run.

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { IconMetadataEntry, IconTaggingRecord } from './types.ts';
import { selectAllIcons, selectIconSample } from './selectIcons.ts';
import { normalizeSvg, rasterizeSvgToPng } from './prepareImage.ts';
import { generateTagsForIcon } from './ollamaClient.ts';
import { buildReportHtml } from './generateReport.ts';

// --------------------------------------------------------------------------
// Locate the icon package's files on disk
// --------------------------------------------------------------------------
// We installed @workday/canvas-system-icons-web as a regular dependency, so
// its files live under node_modules/. Rather than hardcoding that path
// (which would break if the package's install location ever changed), we
// ask Node to resolve the package's own package.json and work out the
// package's root folder from there.
//
// `createRequire` gives us a CommonJS-style `require()` function to use
// inside this ES module (ES modules don't have `require.resolve` built in).
// Docs: https://nodejs.org/api/module.html#modulecreaterequirefilename
const require = createRequire(import.meta.url);
const packageJsonPath = require.resolve('@workday/canvas-system-icons-web/package.json');
const packageRoot = path.dirname(packageJsonPath);

const ACTIVE_METADATA_PATH = path.join(packageRoot, 'dist/metadata/system.metadata.json');
const SVG_DIRECTORY = path.join(packageRoot, 'dist/svg');

const OUTPUT_DIR = path.join(import.meta.dirname, '..', 'output');
const OUTPUT_IMAGES_DIR = path.join(OUTPUT_DIR, 'images');
const TAGS_JSON_PATH = path.join(OUTPUT_DIR, 'tags.json');
const REPORT_HTML_PATH = path.join(OUTPUT_DIR, 'report.html');

const MODEL_NAME = 'qwen2.5vl:7b';

// If this many icons in a row fail, we stop the run instead of continuing
// to the end. In practice, one icon failing on its own is usually a fluke
// (a single bad response), but several IN A ROW almost always means
// something bigger broke -- most likely Ollama itself stopped responding
// -- and there's no point burning through the rest of an 800-icon list
// with near-instant failures. Stopping early with a clear message is much
// more useful than a wall of stack traces followed by "0 succeeded".
const MAX_CONSECUTIVE_FAILURES = 5;

// --------------------------------------------------------------------------
// Loading and saving output/tags.json
// --------------------------------------------------------------------------

/**
 * Loads whatever tagging results already exist on disk (from any earlier
 * run -- sample or full), keyed by icon name.
 *
 * This is what makes a run resumable: if this file already has a
 * successful record for an icon, we can skip re-querying the model for it.
 * It's also what stops a small "sample" run from accidentally erasing a
 * much bigger "full" run's results -- we always start from whatever is
 * already there and only touch the icons THIS run was asked to process.
 *
 * Returns an empty map if the file doesn't exist yet, or can't be parsed
 * (e.g. it was left in a half-written state by a run that got killed --
 * see writeFileAtomically() below for how we try to prevent that going
 * forward, but old/corrupt files are still handled gracefully here rather
 * than crashing the whole run).
 */
function loadExistingRecords(): Map<string, IconTaggingRecord> {
  if (!existsSync(TAGS_JSON_PATH)) {
    return new Map();
  }
  try {
    const existingRecords: IconTaggingRecord[] = JSON.parse(readFileSync(TAGS_JSON_PATH, 'utf-8'));
    return new Map(existingRecords.map((record) => [record.name, record]));
  } catch (error) {
    console.warn(`Could not read existing ${TAGS_JSON_PATH}, starting fresh:`, error);
    return new Map();
  }
}

/**
 * Writes text to a file "atomically": it writes to a temporary file first,
 * then renames that temporary file over the real target path. A rename is
 * a single filesystem operation, so a program that crashes or gets killed
 * mid-write can never leave `filePath` itself half-written/corrupted --
 * either the rename happened (new content) or it didn't (old content is
 * untouched). This matters a lot here because a full run can take hours
 * and we save progress after every single icon during that time.
 * Reference: https://nodejs.org/api/fs.html#fsrenamesyncoldpath-newpath
 */
function writeFileAtomically(filePath: string, contents: string): void {
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, contents);
  renameSync(temporaryPath, filePath);
}

/** Writes the current set of tagging results to both output files. */
function saveOutputs(recordsByName: Map<string, IconTaggingRecord>): void {
  const records = [...recordsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  writeFileAtomically(TAGS_JSON_PATH, JSON.stringify(records, null, 2));
  writeFileAtomically(REPORT_HTML_PATH, buildReportHtml(records));
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const allIcons: IconMetadataEntry[] = JSON.parse(readFileSync(ACTIVE_METADATA_PATH, 'utf-8'));

  // `process.argv` is the list of command-line arguments the script was
  // started with. `npm run tag:all` runs `tsx src/run.ts --all`, so we
  // check for that flag to decide which set of icons to process.
  const useFullIconSet = process.argv.includes('--all');
  const iconsToProcess = useFullIconSet ? selectAllIcons(allIcons) : selectIconSample(allIcons);

  // `recursive: true` means "also create any missing parent folders, and
  // don't error if the folder already exists" -- equivalent to `mkdir -p`.
  mkdirSync(OUTPUT_IMAGES_DIR, { recursive: true });

  const recordsByName = loadExistingRecords();
  let processedCount = 0;
  let skippedCount = 0;
  let consecutiveFailures = 0;
  let stoppedEarly = false;

  for (const [index, icon] of iconsToProcess.entries()) {
    const progress = `[${index + 1}/${iconsToProcess.length}]`;

    const existingRecord = recordsByName.get(icon.name);
    if (existingRecord && existingRecord.generated !== null) {
      // Already tagged successfully in an earlier run -- no need to spend
      // several seconds re-querying the model for the same result.
      console.log(`${progress} ${icon.name} (${icon.category}) -- already tagged, skipping`);
      skippedCount += 1;
      continue;
    }

    console.log(`${progress} ${icon.name} (${icon.category})`);

    // Wrapping each icon's work in try/catch means one bad response (a
    // network hiccup, an unreadable file, etc.) doesn't abort the entire
    // batch -- we log the failure and move on to the next icon. Because we
    // don't add/update a record for a failed icon, it'll automatically be
    // retried the next time this script runs (it won't have a successful
    // `existingRecord` to skip).
    try {
      const rawSvg = readFileSync(path.join(SVG_DIRECTORY, icon.filename), 'utf-8');
      const pngBuffer = await rasterizeSvgToPng(normalizeSvg(rawSvg));

      const imagePath = `images/${icon.name}.png`;
      writeFileSync(path.join(OUTPUT_DIR, imagePath), pngBuffer);

      const { generated, rawModelResponse, validationError } = await generateTagsForIcon(icon, pngBuffer);

      recordsByName.set(icon.name, {
        name: icon.name,
        filename: icon.filename,
        category: icon.category,
        figmaName: icon.figmaName,
        existingTags: icon.tags,
        generated,
        rawModelResponse,
        imagePath,
        modelName: MODEL_NAME,
        generatedAt: new Date().toISOString(),
        validationError,
      });
      processedCount += 1;
      consecutiveFailures = 0; // this icon succeeded, so any earlier streak of failures is over
    } catch (error) {
      console.error(`  FAILED: ${icon.name}:`, error);
      consecutiveFailures += 1;

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(
          `\nStopping early: ${consecutiveFailures} icons in a row failed. This usually means ` +
            `Ollama stopped responding rather than a problem with any single icon. Check that it's ` +
            `running (e.g. "ollama list") and re-run this command -- already-tagged icons will be ` +
            `skipped automatically, so it'll pick up where it left off.`,
        );
        stoppedEarly = true;
      }
    }

    // Why we save after every icon: a full run processes ~800 icons at
    // roughly 20-40 seconds each, which adds up to hours. If the process
    // gets interrupted (laptop sleeps, terminal closes, Ollama restarts)
    // and we only saved once at the very end, we'd lose ALL of that work.
    // Saving after every icon means the worst case is losing progress on
    // the ONE icon that was in flight when it stopped.
    saveOutputs(recordsByName);

    if (stoppedEarly) {
      break;
    }
  }

  console.log(
    `\n${stoppedEarly ? 'Stopped early' : 'Done'}: ${processedCount} icon(s) newly tagged, ` +
      `${skippedCount} already tagged and skipped, ${recordsByName.size} total tagged icons on record.`,
  );
  console.log(`Open output/report.html in a browser to review the results.`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exitCode = 1;
});
