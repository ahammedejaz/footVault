"use client";

import * as React from "react";
import { AlertTriangle, Check, ImageUp, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addProductImage } from "@/lib/actions/admin/products";
import { normaliseUpload } from "@/lib/actions/admin/image-pipeline";
import {
  CANONICAL_EDGE,
  MIN_RECOMMENDED_EDGE,
  UPLOAD_RECOMMENDATION,
} from "@/lib/images/constants";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";

/**
 * Choosing a photograph, seeing what the shop will make of it, and describing
 * it — before any of it is committed.
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
 * twice. The pipeline pads to a square and the card letterboxes that into 4:5,
 * so a shoe shot too close is cropped by nothing and still looks wrong. The
 * preview below is **the real card frame** — same aspect ratio, same `bg-fog`,
 * same `object-contain` — so what is on screen here is what is on the
 * storefront.
 *
 * And a photograph that is too small should be refused-with-a-reason at the
 * moment of choosing, not discovered later on a product page. The pipeline
 * upscales to keep every product at the same scale, which is the right
 * behaviour and also the one that makes a small source look soft.
 *
 * ## The order of operations, and why the original goes first
 *
 * The browser compresses, uploads the **original** to `originals/`, and only
 * then asks the server to normalise it. The original is kept forever: the
 * pipeline is a pure function of it, so a change to the frame — or the arrival
 * of a better encoder — is a reprocess rather than a re-upload of a catalogue
 * that may no longer exist on anybody's phone.
 *
 * If normalisation fails, an original is left in storage attached to nothing.
 * That is the deliberate direction to fail in: a stray original costs a few
 * hundred kilobytes and can be reprocessed, whereas attaching the row first and
 * failing second would put a product image on the shop pointing at an
 * unprocessed file.
 */

/** The bucket's own ceiling, and the copy has to agree with it. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const BUCKET = "product-images";
const ACCEPTED = ["image/jpeg", "image/png", "image/webp", "image/avif"];
const WEBP_QUALITY = 0.82;

type Staged = {
  file: File;
  /** The compressed bytes actually uploaded. */
  blob: Blob;
  previewUrl: string;
  width: number;
  height: number;
  tooSmall: boolean;
};

type Phase =
  | { step: "idle" }
  | { step: "reading" }
  | { step: "uploading"; percent: number }
  | { step: "processing" }
  | { step: "attaching" };

export function ImageUploadPanel({
  productId,
  productName,
  existingCount,
  onAdded,
}: {
  productId: string;
  productName: string;
  /** Drives the two-shot guidance: what is still missing. */
  existingCount: number;
  onAdded: () => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const altId = React.useId();
  const [staged, setStaged] = React.useState<Staged | null>(null);
  const [altText, setAltText] = React.useState("");
  const [phase, setPhase] = React.useState<Phase>({ step: "idle" });

  const busy = phase.step !== "idle";

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
      toast.failed(
        `${file.name} is still ${(prepared.blob.size / 1048576).toFixed(1)}MB after compressing. Five megabytes is the limit.`,
      );
      return;
    }

    if (staged) URL.revokeObjectURL(staged.previewUrl);
    setStaged({
      file,
      blob: prepared.blob,
      previewUrl: URL.createObjectURL(prepared.blob),
      width: prepared.width,
      height: prepared.height,
      tooSmall:
        prepared.width < MIN_RECOMMENDED_EDGE ||
        prepared.height < MIN_RECOMMENDED_EDGE,
    });
    setAltText("");
    setPhase({ step: "idle" });
  }

  function discard() {
    if (staged) URL.revokeObjectURL(staged.previewUrl);
    setStaged(null);
    setAltText("");
    if (inputRef.current) inputRef.current.value = "";
  }

  async function commit() {
    if (!staged || altText.trim().length === 0) return;

    const extension = staged.blob.type === "image/webp" ? "webp" : "jpg";
    const path = `originals/${productId}/${crypto.randomUUID()}.${extension}`;

    setPhase({ step: "uploading", percent: 0 });
    const supabase = createClient();
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, staged.blob, {
        contentType: staged.blob.type,
        cacheControl: "31536000",
        upsert: false,
      });

    if (error) {
      setPhase({ step: "idle" });
      toast.failed(`That did not upload. ${error.message}`);
      return;
    }

    setPhase({ step: "processing" });
    const processed = await normaliseUpload({ path });
    if (!processed.ok) {
      setPhase({ step: "idle" });
      toast.failed(processed.message);
      return;
    }

    const { data } = supabase.storage
      .from(BUCKET)
      .getPublicUrl(processed.canonicalPath);

    setPhase({ step: "attaching" });
    const added = await addProductImage({
      productId,
      url: data.publicUrl,
      altText: altText.trim(),
    });
    setPhase({ step: "idle" });

    if (!added.ok) {
      toast.failed(added.message);
      return;
    }

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
            {nextShotHint(existingCount)} Pictures are shrunk to{" "}
            {CANONICAL_EDGE}px and converted to WebP in this browser first, so a
            photograph straight off a phone does not cost a customer four
            megabytes.
          </p>
        </>
      ) : (
        <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
          <div>
            {/*
              The real frame: aspect-4/5, bg-fog and object-contain are the same
              three the storefront card uses. A generic square thumbnail here
              would show the owner something the shop never renders, which is
              how a photograph gets approved and then looks wrong in the grid.
            */}
            <div className="bg-fog relative aspect-4/5 overflow-hidden rounded-lg">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={staged.previewUrl}
                alt=""
                className="absolute inset-0 size-full object-contain"
              />
            </div>
            <p className="text-muted-foreground mt-1 text-center text-xs">
              how it appears on a card
            </p>
          </div>

          <div className="space-y-3">
            <p className="text-sm">
              <span className="font-medium">{staged.file.name}</span>{" "}
              <span className="text-muted-foreground">
                — {staged.width} × {staged.height}px,{" "}
                {(staged.blob.size / 1024).toFixed(0)}KB after compressing
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

            <div>
              <label
                htmlFor={altId}
                className="mb-1 block text-sm font-medium"
              >
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

            {busy ? (
              <p className="text-muted-foreground text-sm" aria-live="polite">
                {phaseLabel(phase)}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy || altText.trim().length === 0}
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
    case "processing":
      return "Squaring it up and making the sizes the shop needs…";
    case "attaching":
      return "Adding it to the product…";
    default:
      return "";
  }
}

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
 */
async function shrink(
  file: File,
): Promise<{ blob: Blob; width: number; height: number }> {
  if (typeof createImageBitmap !== "function") {
    return { blob: file, width: 0, height: 0 };
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(
      1,
      CANONICAL_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      return { blob: file, width: bitmap.width, height: bitmap.height };
    }
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/webp", WEBP_QUALITY);
    });

    if (!blob || blob.size >= file.size) {
      return { blob: file, width: bitmap.width, height: bitmap.height };
    }
    // The *decoded* dimensions are what the warning must be about: the file may
    // be 4000px wide and, once the portrait tag is applied, 3000px on its
    // shortest side. Reporting the pre-rotation pair would warn about the wrong
    // number.
    return { blob, width: bitmap.width, height: bitmap.height };
  } catch (error) {
    console.warn("[admin] could not compress, sending the original:", error);
    return { blob: file, width: 0, height: 0 };
  } finally {
    bitmap?.close();
  }
}
