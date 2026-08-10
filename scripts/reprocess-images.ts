/**
 * `npm run images:reprocess` — re-run the pipeline over every product
 * photograph.
 *
 *   npm run images:reprocess -- --dry-run     # say what would change
 *   npm run images:reprocess                  # do it
 *   npm run images:reprocess -- --stage       # against staging instead
 *
 * ## What this is for
 *
 * Two things, and the second is the one that justifies keeping originals.
 *
 * **Real photography replacing the placeholders.** The catalogue currently
 * renders drawn SVGs from `scripts/generate-seed-images.ts`. When real
 * photographs arrive they are uploaded through the admin, and this exists to
 * bring anything already uploaded up to the current pipeline.
 *
 * **A change to the frame.** The pad colour, the canonical edge, the emitted
 * widths and the encoder settings are all baked into stored bytes. Bump
 * `PIPELINE_VERSION` and run this, and the catalogue is rebuilt without anyone
 * re-uploading a photograph — which matters because the owner's phone will not
 * still have them.
 *
 * ## Why it is safe to run repeatedly
 *
 * Derivative paths are a hash of the output plus the pipeline version, so
 * re-running over an unchanged original recomputes the same paths and writes
 * byte-identical files. Nothing flickers, nothing is orphaned, and a run that
 * dies halfway can simply be run again.
 *
 * A version bump writes to *new* paths rather than overwriting the live ones,
 * so the old catalogue keeps rendering until each row is repointed. A
 * half-finished reprocess is never a half-broken shop.
 *
 * ## What it will not do
 *
 * It only reprocesses rows whose original it can find. An image row pointing at
 * `/seed/*.svg` has no original in the bucket and is **reported and skipped**,
 * never guessed at — those are placeholders and the fix for them is real
 * photography, not a re-encode of a drawing.
 */

import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";

import {
  CANONICAL_EDGE,
  PIPELINE_VERSION,
} from "../src/lib/images/constants";
import {
  derivativePath,
  normaliseProductImage,
} from "../src/lib/images/pipeline";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const DRY_RUN = process.argv.includes("--dry-run");
const STAGE = process.argv.includes("--stage");
const BUCKET = "product-images";

const url = STAGE
  ? process.env.SUPABASE_STAGE_URL
  : process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = STAGE
  ? process.env.SUPABASE_STAGE_SERVICE_ROLE_KEY
  : process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error(
    `\nMissing credentials for ${STAGE ? "staging" : "production"}.\n`,
  );
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

/**
 * The storage path inside `product-images` that a stored URL refers to, or null
 * when the URL is not one of ours.
 *
 * Returning null rather than a best guess is deliberate: a wrong path here
 * would attach a product to somebody else's photograph, and "we could not tell"
 * is a reportable state whereas a plausible wrong answer is not.
 */
function storagePathOf(publicUrl: string): string | null {
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const at = publicUrl.indexOf(marker);
  return at === -1 ? null : publicUrl.slice(at + marker.length);
}

function isDerivativePath(path: string): boolean {
  return path.startsWith("derived/");
}

/**
 * What to actually feed the pipeline for this row.
 *
 * After a first pass, `url` points at `derived/v1/<hash>/…`, which is an
 * **output**. Re-running the pipeline over it would compound the compression a
 * little further on every version bump, so the row's `original_path` is used
 * instead — that column exists for precisely this moment.
 *
 * Before it existed, a bumped `PIPELINE_VERSION` skipped every already-processed
 * row and reported a confident zero: the reprocessor silently declined to
 * rebuild exactly the images it is for. Rows written before the column was added
 * still return null here and are still skipped, but now they are skipped with a
 * reason a human can act on rather than as an unexplained no-op.
 */
function sourceFor(row: {
  url: string;
  original_path: string | null;
}): { path: string; fromColumn: boolean } | null {
  const stored = storagePathOf(row.url);
  if (stored && !isDerivativePath(stored)) {
    return { path: stored, fromColumn: false };
  }
  if (row.original_path) return { path: row.original_path, fromColumn: true };
  return null;
}

async function main() {
  console.log(
    `\n\x1b[1mReprocessing product photographs\x1b[0m` +
      ` — pipeline v${PIPELINE_VERSION}, ${CANONICAL_EDGE}px canonical` +
      `${STAGE ? ", STAGING" : ", production"}` +
      `${DRY_RUN ? ", DRY RUN" : ""}\n`,
  );

  const { data: rows, error } = await supabase
    .from("product_images")
    .select("id, url, product_id, original_path")
    .overrideTypes<
      {
        id: string;
        url: string;
        product_id: string;
        original_path: string | null;
      }[]
    >();

  if (error || !rows) {
    console.error(`Could not read product_images: ${error?.message}`);
    process.exit(1);
  }

  let processed = 0;
  let skippedPlaceholder = 0;
  let skippedDerivative = 0;
  let failures = 0;

  for (const row of rows) {
    const stored = storagePathOf(row.url);

    if (!stored && !row.original_path) {
      skippedPlaceholder += 1;
      console.log(
        `  \x1b[90m·\x1b[0m skip ${row.url.slice(0, 60)} — not in the bucket ` +
          `(a seed placeholder; needs real photography, not a re-encode)`,
      );
      continue;
    }

    const source = sourceFor(row);
    if (!source) {
      skippedDerivative += 1;
      console.log(
        `  \x1b[33m!\x1b[0m skip ${stored?.slice(0, 60) ?? row.url.slice(0, 60)} — ` +
          `already a derivative and no original_path on the row. It predates ` +
          `that column, so its original cannot be identified; re-upload it to ` +
          `bring it back under the pipeline.`,
      );
      continue;
    }

    const path = source.path;

    const { data: file, error: downloadError } = await supabase.storage
      .from(BUCKET)
      .download(path);

    if (downloadError || !file) {
      failures += 1;
      console.log(
        `  \x1b[31m✗\x1b[0m ${path} — could not read: ${downloadError?.message ?? "no body"}`,
      );
      continue;
    }

    let result;
    try {
      result = await normaliseProductImage(
        Buffer.from(await file.arrayBuffer()),
      );
    } catch (caught) {
      failures += 1;
      console.log(
        `  \x1b[31m✗\x1b[0m ${path} — ${caught instanceof Error ? caught.message : "unknown"}`,
      );
      continue;
    }

    const stem =
      (path.split("/").pop() ?? "image")
        .replace(/\.[^.]+$/, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "image";

    const canonical = derivativePath(stem, result.contentHash, CANONICAL_EDGE);

    if (DRY_RUN) {
      processed += 1;
      console.log(
        `  \x1b[36m→\x1b[0m ${path}\n      would become ${canonical}` +
          `${result.belowRecommended ? "  \x1b[33m(source is small; it will be upscaled)\x1b[0m" : ""}`,
      );
      continue;
    }

    let wrote = 0;
    for (const variant of result.variants) {
      const target = derivativePath(stem, result.contentHash, variant.width);
      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(target, variant.data, {
          contentType: "image/webp",
          upsert: true,
          cacheControl: "31536000",
        });
      if (uploadError) {
        failures += 1;
        console.log(`  \x1b[31m✗\x1b[0m ${target} — ${uploadError.message}`);
        break;
      }
      wrote += 1;
    }

    if (wrote !== result.variants.length) continue;

    const { data: publicUrl } = supabase.storage
      .from(BUCKET)
      .getPublicUrl(canonical);

    /*
      There is deliberately no "already current, skip the write" branch here.
      A row that has been processed points at `derived/…` and is caught by the
      already-derivative skip far above, so the comparison would never be
      reached — it was in the first version of this script and re-running proved
      it dead. A counter that can only ever report zero reads as coverage.
    */

    const { error: updateError } = await supabase
      .from("product_images")
      .update({ url: publicUrl.publicUrl, original_path: path })
      .eq("id", row.id);

    if (updateError) {
      failures += 1;
      console.log(`  \x1b[31m✗\x1b[0m row ${row.id} — ${updateError.message}`);
      continue;
    }

    processed += 1;
    console.log(
      `  \x1b[32m✓\x1b[0m ${path}${source.fromColumn ? " (from original_path)" : ""}\n      → ${canonical}` +
        `  ${result.variants.map((v) => `${v.width}:${(v.bytes / 1024).toFixed(0)}KB`).join(" ")}`,
    );
  }

  console.log(
    `\n\x1b[1m${DRY_RUN ? "Would process" : "Processed"} ${processed}\x1b[0m` +
      `, ${skippedPlaceholder} seed placeholders skipped` +
      `, ${skippedDerivative} already-derivative rows skipped` +
      `, ${failures} failed.\n` +
      (skippedPlaceholder > 0
        ? "The skipped placeholders are drawn SVGs. They need real photography;\n" +
          "re-encoding a drawing would not improve it.\n\n"
        : ""),
  );

  if (failures > 0) process.exit(1);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
