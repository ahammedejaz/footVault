"use client";

import * as React from "react";
import { AlertTriangle, Check, Crop as CropIcon, ImageUp, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CropControls,
  CropStage,
  type Frame,
  type Subject,
} from "@/components/admin/products/crop-stage";
import { addProductImage } from "@/lib/actions/admin/products";
import {
  normaliseUpload,
  proposeFrame,
} from "@/lib/actions/admin/image-pipeline";
import {
  MAX_UPLOAD_BYTES,
  MIN_RECOMMENDED_EDGE,
  UPLOAD_EDGE,
  UPLOAD_EDGE_LADDER,
  UPLOAD_RECOMMENDATION,
} from "@/lib/images/constants";
import { DEFAULT_CROP, type Crop } from "@/lib/images/crop";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";

/**
 * Choosing a photograph, framing it, describing it, and only then committing.
 *
 * ## The order, and why the upload now happens in the middle
 *
 * The flow is **choose → frame → describe → commit**, and the original is put
 * into Storage the moment a file is chosen rather than at the end.
 *
 * That is not a smaller change than it sounds. Auto-frame runs server-side —
 * `sharp` finds the shoe, the target fill comes from a settings row — so the
 * bytes have to be somewhere the server can read before there is anything to
 * propose. Uploading at commit time would mean the owner frames, presses the
 * button, and *then* waits for an upload; uploading at choose time means the
 * network works while the human does, and by the time the first drag is over
 * the proposal is already on screen.
 *
 * If normalisation later fails, an original is left in storage attached to
 * nothing. That is the deliberate direction to fail in: a stray original costs
 * a few hundred kilobytes and can be reprocessed, whereas attaching the row
 * first and failing second would put a product image on the shop pointing at
 * an unprocessed file.
 *
 * ## Why the upload is staged rather than immediate
 *
 * The old panel uploaded on file-select and attached the row straight away,
 * with a blank description to be filled in afterwards from a list. Three things
 * follow from that and all three are the reason this exists:
 *
 * A description added *afterwards* is a description that does not get added.
 * The box sits in a list of ten identical boxes with a placeholder explaining
 * what would happen if it were filled in, which is a different activity from
 * describing the photograph you are looking at. Here it is a required field
 * beside the picture, and the button that commits is disabled without it.
 *
 * A photograph the owner cannot see framed is a photograph that gets uploaded
 * twice — and framing it is now something they do rather than something they
 * hope for.
 *
 * And a photograph that is too small should be refused-with-a-reason at the
 * moment of choosing, not discovered later on a product page. The pipeline
 * upscales to keep every product at the same scale, which is the right
 * behaviour and also the one that makes a small source look soft.
 *
 * ## The crop is six numbers, and they never become pixels here
 *
 * The browser sends `{cx, cy, size, rotation, brightness, contrast}` and the
 * server cuts the asset. No canvas, no second encoder, no pixels crossing the
 * wire twice — and because the numbers are recorded on the row, the same
 * framing can be re-applied to the same original next year by a pipeline that
 * has changed underneath it.
 */

const BUCKET = "product-images";
const ACCEPTED = ["image/jpeg", "image/png", "image/webp", "image/avif"];
const WEBP_QUALITY = 0.82;

/**
 * The last framing committed in this session, reused as the starting point for
 * the next photograph.
 *
 * Module scope rather than component state on purpose: the panel unmounts and
 * remounts as the owner moves between products, and "the same table, the same
 * distance, the same light" outlives that. It resets on reload, which is the
 * right lifetime — a session is one photography sitting.
 *
 * **Auto-frame still wins on framing when it finds the shoe.** What is
 * inherited from the last crop is the part detection cannot know and the room
 * does not change between shots: the straighten angle and the tone. Framing is
 * per-photograph; the table being three degrees off square is not.
 */
let lastCrop: Crop | null = null;

type Staged = {
  file: File;
  /** The compressed bytes actually uploaded. */
  blob: Blob;
  previewUrl: string;
  /** The source as the camera took it, after its orientation tag is applied. */
  width: number;
  height: number;
  /**
   * What is inside `blob` — the size the crop step works with, and the size
   * `originals/` keeps forever.
   */
  storedWidth: number;
  storedHeight: number;
  tooSmall: boolean;
  /** Where it landed in Storage, once the background upload finishes. */
  path: string | null;
};

type Phase =
  | { step: "idle" }
  | { step: "reading" }
  | { step: "uploading" }
  | { step: "framing" }
  | { step: "processing" }
  /**
   * Throttled, waiting, and about to try again on its own.
   *
   * A distinct phase rather than a failure toast. The limiter exists to stop a
   * stuck client, not to stop the owner, and a red "that did not work" partway
   * through a photography session reads as the shop breaking rather than as
   * "wait four seconds". The file stays staged, the description stays typed,
   * and the retry happens without anyone pressing anything.
   */
  | { step: "waiting"; seconds: number }
  | { step: "attaching" };

export function ImageUploadPanel({
  productId,
  productName,
  existingCount,
  colourways,
  targetFill,
  onAdded,
}: {
  productId: string;
  productName: string;
  /** Drives the two-shot guidance: what is still missing. */
  existingCount: number;
  /**
   * This product's real colourways, in the order the variant editor lists them.
   *
   * Derived from `product_variants.color` on the server rather than typed here,
   * because a colourway that is not on a variant does not exist: the storefront
   * builds the swatches from the variants and matches photographs to them by
   * exact string. A free-text box would let the owner file a photograph under
   * "navy" against a "Navy" colourway and see it vanish.
   */
  colourways: readonly string[];
  /**
   * The fraction the fill guide is drawn at, read from the owner's settings on
   * the server. Passed in rather than fetched here so the guide is correct on
   * the very first paint, before any photograph has been chosen.
   */
  targetFill: number;
  onAdded: () => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const altId = React.useId();
  const colourId = React.useId();
  const [staged, setStaged] = React.useState<Staged | null>(null);
  const [altText, setAltText] = React.useState("");
  /**
   * Which colourway this shot is of. `""` is "every colourway" and is the
   * default on purpose.
   *
   * Defaulting to the first colourway would be the tidier-looking choice and is
   * the wrong one: a photograph filed under the wrong colour is invisible on
   * the page the owner was looking at, whereas one shown on all of them is
   * wrong in a way they can see immediately and fix from the list below. The
   * expensive mistake is the silent one.
   *
   * It is **not** carried across shots the way the crop is. Two photographs in
   * a row are usually the same shoe from two angles, but they are just as often
   * the next colourway — and inheriting a colour would file the second one
   * under the first one's name without anybody choosing it.
   */
  const [colour, setColour] = React.useState("");
  const [phase, setPhase] = React.useState<Phase>({ step: "idle" });
  const [crop, setCrop] = React.useState<Crop>(DEFAULT_CROP);
  const [frame, setFrame] = React.useState<Frame | null>(null);
  const [subject, setSubject] = React.useState<Subject | null>(null);
  const [autoFramed, setAutoFramed] = React.useState<boolean | null>(null);

  /**
   * Busy means "do not touch anything", and the two network steps that run
   * *while the owner frames* are deliberately not it. Disabling the square
   * during its own upload would take the tool away at the exact moment the
   * overlap was designed to give it back.
   */
  const busy =
    phase.step !== "idle" &&
    phase.step !== "framing" &&
    phase.step !== "uploading";
  const ready = staged !== null && staged.path !== null && frame !== null;

  React.useEffect(() => {
    // A blob URL that is not revoked is a leak that survives every re-render.
    return () => {
      if (staged) URL.revokeObjectURL(staged.previewUrl);
    };
  }, [staged]);

  async function choose(file: File) {
    if (!ACCEPTED.includes(file.type)) {
      toast.failed(
        `${file.name} is a ${file.type || "kind of file"} the shop cannot use. JPEG, PNG, WebP or AVIF.`,
      );
      return;
    }

    setPhase({ step: "reading" });
    const prepared = await shrink(file);

    if (prepared.blob.size > MAX_UPLOAD_BYTES) {
      setPhase({ step: "idle" });
      // The ladder has already been walked to the bottom by this point, so the
      // sentence names the smallest size that was tried. "Still 6MB" without
      // "at 1600px" reads as though nothing was attempted.
      toast.failed(
        `${file.name} is still ${(prepared.blob.size / 1048576).toFixed(1)}MB after compressing it down to ${UPLOAD_EDGE_LADDER[UPLOAD_EDGE_LADDER.length - 1]}px. Five megabytes is the limit.`,
      );
      return;
    }

    if (staged) URL.revokeObjectURL(staged.previewUrl);

    const next: Staged = {
      file,
      blob: prepared.blob,
      previewUrl: URL.createObjectURL(prepared.blob),
      width: prepared.width,
      height: prepared.height,
      storedWidth: prepared.storedWidth,
      storedHeight: prepared.storedHeight,
      tooSmall:
        prepared.width < MIN_RECOMMENDED_EDGE ||
        prepared.height < MIN_RECOMMENDED_EDGE,
      path: null,
    };

    setStaged(next);
    setAltText("");
    setColour("");
    setAutoFramed(null);
    setSubject(null);
    /**
     * The frame is known locally before the server answers, so the square is
     * draggable during the upload rather than after it. The server's own
     * measurement replaces it when the proposal lands — they agree, and the
     * server's is the one the asset is actually cut from.
     */
    setFrame(
      prepared.storedWidth > 0
        ? { width: prepared.storedWidth, height: prepared.storedHeight }
        : { width: prepared.width, height: prepared.height },
    );
    setCrop({
      ...DEFAULT_CROP,
      rotation: lastCrop?.rotation ?? 0,
      brightness: lastCrop?.brightness ?? 0,
      contrast: lastCrop?.contrast ?? 0,
    });

    void upload(next);
  }

  /** Put the original in Storage, then ask the server how to frame it. */
  async function upload(item: Staged) {
    const supabase = createClient();
    const extension = item.blob.type === "image/webp" ? "webp" : "jpg";
    const path = `originals/${productId}/${crypto.randomUUID()}.${extension}`;

    setPhase({ step: "uploading" });
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, item.blob, {
        contentType: item.blob.type,
        cacheControl: "31536000",
        upsert: false,
      });

    if (error) {
      setPhase({ step: "idle" });
      toast.failed(`That did not upload. ${error.message}`);
      return;
    }

    setStaged((prev) => (prev ? { ...prev, path } : prev));
    setPhase({ step: "framing" });
    await propose(path, lastCrop?.rotation ?? 0);
    setPhase({ step: "idle" });
  }

  /**
   * Ask the server where the shoe is and how to frame it.
   *
   * Called again after a straighten, because rotating the picture changes the
   * rectangle everything is measured against — a bounding box found on the
   * unrotated frame would make the fill readout quietly wrong the moment the
   * slider moved.
   */
  async function propose(path: string, rotation: number, keepFraming = false) {
    const result = await proposeFrame({ path, rotation });
    if (!result.ok) {
      // Not a toast. Auto-frame is an assist; failing to get one leaves the
      // owner exactly where they would have been without it, and a red banner
      // would make a missing convenience look like a broken upload.
      setAutoFramed(false);
      return;
    }

    setFrame(result.frame);
    setSubject(result.subject);
    setAutoFramed(result.subject !== null);

    if (!keepFraming) {
      setCrop((prev) => ({
        ...result.crop,
        // The room's constants, not the photograph's: kept across shots.
        rotation: prev.rotation,
        brightness: prev.brightness,
        contrast: prev.contrast,
      }));
    }
  }

  function discard() {
    if (staged) URL.revokeObjectURL(staged.previewUrl);
    setStaged(null);
    setAltText("");
    setColour("");
    setFrame(null);
    setSubject(null);
    setAutoFramed(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function commit() {
    if (!staged?.path || altText.trim().length === 0) return;

    setPhase({ step: "processing" });
    const processed = await normaliseUpload({ path: staged.path, crop });

    if (!processed.ok) {
      if (processed.reason === "throttled") {
        const wait = Math.max(1, processed.retryAfterSeconds);
        for (let left = wait; left > 0; left -= 1) {
          setPhase({ step: "waiting", seconds: left });
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return commit();
      }
      setPhase({ step: "idle" });
      toast.failed(processed.message);
      return;
    }

    const supabase = createClient();
    const { data } = supabase.storage
      .from(BUCKET)
      .getPublicUrl(processed.canonicalPath);

    setPhase({ step: "attaching" });
    const added = await addProductImage({
      productId,
      url: data.publicUrl,
      // Echoed back by the server rather than reused from the state above, so
      // the row can only ever name the file and the framing that were actually
      // processed.
      originalPath: processed.originalPath,
      crop: processed.crop,
      altText: altText.trim(),
      color: colour,
    });
    setPhase({ step: "idle" });

    if (!added.ok) {
      toast.failed(added.message);
      return;
    }

    lastCrop = processed.crop ?? crop;

    if (processed.overBudget.length > 0) {
      toast.done(
        "Photograph added, but it is heavy",
        `The ${processed.overBudget.join(" and ")}px ${processed.overBudget.length === 1 ? "version is" : "versions are"} over budget. A plainer background compresses better.`,
      );
    } else {
      toast.done("Photograph added", nextShotHint(existingCount + 1));
    }

    discard();
    onAdded();
  }

  return (
    <div className="border-border space-y-3 rounded-md border p-3">
      <input
        ref={inputRef}
        id="product-photograph"
        type="file"
        accept={ACCEPTED.join(",")}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void choose(file);
        }}
      />

      {staged === null ? (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              <ImageUp className="size-4" aria-hidden />
              {phase.step === "reading" ? "Reading…" : "Choose a photograph"}
            </Button>
            <p className="text-muted-foreground text-sm">
              {UPLOAD_RECOMMENDATION}
            </p>
          </div>
          {/*
            The two-shot expectation is stated unconditionally, and the
            count-specific nudge sits after it. An earlier version only said
            "outsole" when one photograph was missing, so the standing rule
            became invisible on exactly the products that already satisfied it
            — and a rule you cannot read once you have followed it is a rule
            nobody learns.
          */}
          <p className="text-muted-foreground max-w-prose text-sm text-pretty">
            Two shots per product: the three-quarter view and the outsole.{" "}
            {nextShotHint(existingCount)} Pictures are shrunk to {UPLOAD_EDGE}px
            and converted to WebP in this browser first — large enough to crop
            into later, small enough that a photograph straight off a phone is
            not a four-megabyte upload.
          </p>
        </>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(16rem,22rem)_1fr]">
          <div className="space-y-3">
            {frame ? (
              <CropStage
                src={staged.previewUrl}
                frame={frame}
                crop={crop}
                subject={subject}
                targetFill={targetFill}
                disabled={busy}
                onChange={setCrop}
              />
            ) : null}

            <p className="text-muted-foreground text-center text-xs">
              {phase.step === "uploading"
                ? "Uploading while you frame it…"
                : phase.step === "framing"
                  ? "Looking for the shoe…"
                  : autoFramed === true
                    ? "Framed automatically — nudge it if you disagree"
                    : "This square is what the shop will store"}
            </p>
          </div>

          <div className="space-y-3">
            <p className="text-sm">
              <span className="font-medium">{staged.file.name}</span>{" "}
              <span className="text-muted-foreground">
                — {staged.width} × {staged.height}px,{" "}
                {(staged.blob.size / 1024).toFixed(0)}KB after compressing
                {staged.storedWidth > 0 && staged.storedWidth < staged.width ? (
                  <>
                    {" "}
                    · kept at {staged.storedWidth} × {staged.storedHeight}px
                  </>
                ) : null}
              </span>
            </p>

            {staged.tooSmall ? (
              <p className="text-destructive flex items-start gap-2 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  This is under {MIN_RECOMMENDED_EDGE}px on one side. The shop
                  scales every photograph to the same size so the catalogue
                  looks even, which means this one will be enlarged and will
                  look soft. Use a bigger version if you have one.
                </span>
              </p>
            ) : null}

            <CropControls
              crop={crop}
              disabled={busy}
              onChange={(next) => {
                const straightened = next.rotation !== crop.rotation;
                setCrop(next);
                // Re-measure against the rotated frame, keeping the owner's
                // framing. Fire-and-forget: the readout catches up, and the
                // crop they are dragging is never taken out from under them.
                if (straightened && staged.path) {
                  void propose(staged.path, next.rotation, true);
                }
              }}
            />

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !staged.path}
                onClick={() => {
                  if (staged.path) void propose(staged.path, crop.rotation);
                }}
              >
                <CropIcon className="size-4" aria-hidden />
                Frame it for me
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setCrop({ ...DEFAULT_CROP })}
              >
                Whole photograph
              </Button>
            </div>

            {/*
              Rendered only when the product has more than one colourway.

              A single-colourway product has exactly one answer, and a select
              with one real option plus "every colourway" asks the owner to make
              a distinction that has no consequence on their shop — the two
              choices render identically on every page. On a product with two or
              three, the same control decides whether the photograph is ever
              seen, so it earns the row.
            */}
            {colourways.length > 1 ? (
              <div>
                <label
                  htmlFor={colourId}
                  className="mb-1 block text-sm font-medium"
                >
                  Which colourway is this?
                </label>
                <select
                  id={colourId}
                  value={colour}
                  onChange={(event) => setColour(event.target.value)}
                  disabled={busy}
                  aria-describedby={`${colourId}-why`}
                  className="border-input bg-background h-11 w-full rounded-sm border px-3 text-sm"
                >
                  <option value="">Every colourway</option>
                  {colourways.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <p
                  id={`${colourId}-why`}
                  className="text-muted-foreground mt-1 text-xs text-pretty"
                >
                  The product page shows a colourway&rsquo;s own photographs plus
                  everything marked &ldquo;every colourway&rdquo;. Naming one
                  here keeps a Navy shot off the White swatch.
                </p>
              </div>
            ) : null}

            <div>
              <label htmlFor={altId} className="mb-1 block text-sm font-medium">
                Describe this photograph
              </label>
              <Input
                id={altId}
                value={altText}
                onChange={(event) => setAltText(event.target.value)}
                maxLength={200}
                disabled={busy}
                autoComplete="off"
                placeholder={`e.g. ${productName}, three-quarter view`}
                aria-describedby={`${altId}-why`}
              />
              <p
                id={`${altId}-why`}
                className="text-muted-foreground mt-1 text-xs"
              >
                Required. It is what a customer using a screen reader hears, and
                what shows if the picture fails to load.
              </p>
            </div>

            {phase.step !== "idle" ? (
              <p className="text-muted-foreground text-sm" aria-live="polite">
                {phaseLabel(phase)}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy || !ready || altText.trim().length === 0}
                onClick={() => void commit()}
              >
                <Check className="size-4" aria-hidden />
                Add this photograph
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={discard}
              >
                <X className="size-4" aria-hidden />
                Choose a different one
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Which of the two shots is still missing.
 *
 * The product page's design leans on the outsole picture — the card crossfades
 * to it on hover — so a product with one photograph is a product with a broken
 * interaction rather than a product with fewer pictures. Saying so at the point
 * of upload is the only place it gets read.
 */
function nextShotHint(count: number): string {
  if (count === 0) return "Start with the three-quarter view.";
  if (count === 1) {
    return "Now the outsole — the card crossfades to it when a customer hovers.";
  }
  return "Both are in; anything further is a bonus.";
}

function phaseLabel(phase: Phase): string {
  switch (phase.step) {
    case "reading":
      return "Reading the file…";
    case "uploading":
      return "Uploading…";
    case "framing":
      return "Looking for the shoe…";
    case "waiting":
      return `The shop is pacing itself — trying again in ${phase.seconds}s. Nothing has been lost.`;
    case "processing":
      return "Cutting the square and making the sizes the shop needs…";
    case "attaching":
      return "Adding it to the product…";
    default:
      return "";
  }
}

/**
 * What `shrink` hands back: the bytes to upload, the source it decoded, and the
 * size those bytes actually are.
 *
 * Named rather than inlined because three of the five fields are dimensions and
 * an inline object literal made it possible — it happened — to read the source
 * pair where the stored pair was meant.
 */
type Prepared = {
  blob: Blob;
  /** The decoded source, after its orientation tag is applied. 0 if unreadable. */
  width: number;
  height: number;
  /** What is inside `blob`. 0 when nothing usable was produced. */
  storedWidth: number;
  storedHeight: number;
};

/**
 * Downscale and re-encode in the browser, with no library.
 *
 * **`imageOrientation: "from-image"` is not optional and is the whole reason
 * this comment is long.** A canvas has no EXIF, so whatever comes out of here
 * has lost the orientation tag permanently. If the bitmap were decoded without
 * applying that tag first, a photograph taken with the phone held in portrait
 * would be baked sideways *and* stripped of the only record of which way was
 * up — and the server-side rotation, which is careful and tested, would have
 * nothing left to work with. The historical default for this option was
 * `"none"`; the spec later moved to `"from-image"`. Relying on which browser
 * implements which is exactly the kind of thing that fails on one person's
 * phone and nobody else's.
 *
 * Every failure path returns the original file rather than throwing: a browser
 * that cannot decode a particular photograph should still be able to upload it,
 * slowly, rather than refuse. The result is only used when it is actually
 * smaller — re-encoding an already-tight JPEG as WebP can come out larger, and
 * shipping a bigger file than the owner chose would make this a cost.
 *
 * ## The ladder
 *
 * `UPLOAD_EDGE_LADDER` is walked from the top, and the first rung that fits
 * inside `MAX_UPLOAD_BYTES` wins. Every rung re-encodes from the *bitmap*, not
 * from the rung above it, so stepping down costs a little time and no quality:
 * a chain of re-encodings would compound WebP's losses three times over for a
 * photograph that was merely large.
 *
 * The "it came out bigger, send the original instead" rule applies **only at
 * the top rung**. Lower down, the original is by definition over the ceiling —
 * that is why the ladder is being walked at all — so preferring it there would
 * hand the caller a file it is about to refuse.
 */
async function shrink(file: File): Promise<Prepared> {
  /** The untouched file, with whatever we managed to learn about it. */
  const untouched = (width = 0, height = 0): Prepared => ({
    blob: file,
    width,
    height,
    storedWidth: width,
    storedHeight: height,
  });

  if (typeof createImageBitmap !== "function") return untouched();

  let bitmap: ImageBitmap | null = null;
  try {
    const image = await createImageBitmap(file, {
      imageOrientation: "from-image",
    });
    bitmap = image;

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return untouched(image.width, image.height);

    /**
     * Kept so the refusal message can report the smallest thing actually
     * produced rather than the multi-megabyte file the owner chose. "Still
     * 6.2MB" is only a fair sentence if it describes an attempt.
     */
    let smallest: Blob | null = null;

    for (const [rung, edge] of UPLOAD_EDGE_LADDER.entries()) {
      const scale = Math.min(1, edge / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));

      canvas.width = width;
      canvas.height = height;
      context.drawImage(image, 0, 0, width, height);

      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/webp", WEBP_QUALITY);
      });
      if (!blob) return untouched(image.width, image.height);

      if (rung === 0 && blob.size >= file.size && file.size <= MAX_UPLOAD_BYTES) {
        return untouched(image.width, image.height);
      }

      if (blob.size <= MAX_UPLOAD_BYTES) {
        // The *decoded* dimensions are what the too-small warning must be
        // about: the file may be 4000px wide and, once the portrait tag is
        // applied, 3000px on its shortest side. Reporting the pre-rotation
        // pair would warn about the wrong number.
        return {
          blob,
          width: image.width,
          height: image.height,
          storedWidth: width,
          storedHeight: height,
        };
      }

      if (!smallest || blob.size < smallest.size) smallest = blob;
    }

    // Every rung was over the ceiling. Hand back the smallest attempt so the
    // caller refuses with a number that means something.
    return smallest
      ? {
          blob: smallest,
          width: image.width,
          height: image.height,
          storedWidth: 0,
          storedHeight: 0,
        }
      : untouched(image.width, image.height);
  } catch (error) {
    console.warn("[admin] could not compress, sending the original:", error);
    return untouched();
  } finally {
    bitmap?.close();
  }
}
