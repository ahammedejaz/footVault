-- Which original a product photograph was derived from.
--
-- ## The gap this closes
--
-- Batch A's pipeline writes `product_images.url` pointing at
-- `derived/v1/<hash>/<stem>-1600.webp`, and keeps the untouched upload in
-- `originals/`. Nothing recorded the link between them.
--
-- That is fine until `PIPELINE_VERSION` is bumped — which is the entire reason
-- originals are kept. `scripts/reprocess-images.ts` works from whatever the row
-- points at, and a row pointing at a derivative is skipped, because feeding an
-- output back through the pipeline would compound the compression a little more
-- on every run. So a version bump would skip **exactly the images it exists to
-- rebuild**, and the reprocessor would report a confident zero.
--
-- ## Why now rather than when it bites
--
-- The information needed to backfill this column only exists while the
-- catalogue is small enough to match up by hand. Once a real photography
-- session has put seventy photographs in, `originals/` holds seventy files and
-- `product_images` holds seventy rows, and nothing but the upload timestamps
-- relates one set to the other — timestamps that a reprocess or a re-upload
-- would scramble. Adding the column before the first real session is the
-- difference between a column that is always correct and a column that starts
-- with a seventy-row hole.
--
-- Today the hole is zero rows: no image has been processed twice, and every
-- existing row is either a seed placeholder (`/seed/*.svg`, no original, and
-- correctly null here) or a pre-Phase-10 upload that is itself the original.
--
-- ## A path, not a URL
--
-- `url` is a full public URL because that is what an `<img>` needs. This is a
-- path inside the `product-images` bucket, because that is what the storage API
-- takes and because a URL carries the project host — so a URL written on
-- staging would be a dead link on production, and the column would quietly
-- become useless at exactly the moment a project moved. A path survives that.
--
-- Nullable, with no default and no backfill. Null means "we do not know the
-- original", which is the truth for every seed placeholder and every row that
-- predates the pipeline, and it is a state the reprocessor already reports
-- rather than guesses at.
alter table public.product_images
  add column original_path text;

comment on column public.product_images.original_path is
  'Path inside the product-images bucket of the untouched upload this image was '
  'derived from. Null for seed placeholders and pre-Phase-10 uploads. Written by '
  'addProductImage and by scripts/reprocess-images.ts; read by the reprocessor '
  'so a PIPELINE_VERSION bump can rebuild an already-processed row.';
