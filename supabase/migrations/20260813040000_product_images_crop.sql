-- How a product photograph was framed, so the framing can be repeated.
--
-- ## What this stores, and what it deliberately does not
--
-- Six numbers: the centre and edge of the square the owner chose, a straighten
-- angle, and brightness and contrast. They are **fractions of the frame**, not
-- pixels — see src/lib/images/crop.ts for the reasoning at length. The short
-- version is that a stored pixel rectangle would mean somewhere else the moment
-- the same photograph existed at another resolution, and re-crop reads
-- `original_path`, which is exactly a promise that it will.
--
-- It does not store the cropped image. The derivative is still derived: the
-- pipeline is a pure function of (original, crop), so the asset is reproducible
-- from these six numbers and a PIPELINE_VERSION bump rebuilds it. A crop baked
-- into pixels with no record of how would make re-cropping a re-upload, which
-- is the thing `original_path` was added to prevent.
--
-- ## Null is not "unset", it is "the whole photograph"
--
-- Every row written before this column existed was framed by the pipeline's
-- contain-and-pad, and null says exactly that. It is also the value that keeps
-- them **byte-identical**: `normaliseProductImage` takes the untouched branch
-- for a null crop, so a reprocess of the existing catalogue recomputes the same
-- content hashes and therefore the same paths. Backfilling this column with an
-- explicit default crop would route thirty-five photographs through new
-- arithmetic and rewrite every derivative path in the shop to arrive at
-- approximately the same pixels. So there is no backfill, and there should
-- never be one.
--
-- ## Why jsonb rather than six columns
--
-- Six `numeric` columns would let the database check each range, which is a
-- real advantage and is not the one that decides it. The crop is read and
-- written as a whole — the panel posts all six, the pipeline consumes all six,
-- and there is no query anywhere that filters or sorts on "brightness". Six
-- columns would also make adding a seventh a migration against a table the
-- storefront reads, whereas the shape is already validated in one place
-- (`normaliseCrop`) that both the browser and the server call.
--
-- The check below is deliberately weak for the same reason: it rejects a string
-- or a number written into this column by mistake, and leaves the ranges to the
-- code that clamps them. A tight database constraint on a shape the panel is
-- still learning would fail an owner's save with a message no human wrote.
alter table public.product_images
  add column crop jsonb;

alter table public.product_images
  add constraint product_images_crop_is_object
  check (crop is null or jsonb_typeof(crop) = 'object');

comment on column public.product_images.crop is
  'How this photograph was framed: {cx, cy, size, rotation, brightness, contrast}, '
  'every value a fraction of the frame rather than a pixel count. Null means the '
  'whole photograph contained and padded — what the pipeline did before crops '
  'existed, and the value that keeps pre-existing derivatives byte-identical. '
  'Applied by normaliseProductImage and by scripts/reprocess-images.ts; written '
  'by addProductImage and by the re-crop action. See src/lib/images/crop.ts.';
