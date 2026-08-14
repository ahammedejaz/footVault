"use client";

import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Star } from "lucide-react";

import { ConfirmAction } from "@/components/admin/confirm-action";
import { RecropDialog } from "@/components/admin/products/recrop-dialog";
import { Chip, EmptyState, Panel } from "@/components/admin/ui";
import { ImageUploadPanel } from "@/components/admin/products/image-upload-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  deleteProductImage,
  moveProductImage,
  setImageAlt,
  setImageColor,
} from "@/lib/actions/admin/products";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { AdminImage } from "@/components/admin/products/types";

/**
 * The product's photographs.
 *
 * **The first one is the primary.** "Exactly one primary" is not a database
 * constraint, so making it a position rather than a flag is what guarantees it:
 * there is always exactly one first item in a list, the server rewrites
 * `sort_order` and `is_primary` together on every change, and the order shown
 * here is the order the storefront gallery renders. A separate "primary" tick
 * alongside an independent sort order is two pieces of state that agree until
 * somebody reorders, and then quietly do not.
 *
 * **Up and Down rather than drag-and-drop.** Buttons are operable from a
 * keyboard and announce themselves without a second hidden interface, and on a
 * tablet held in one hand a 44px button is a far more reliable target than a
 * drag across a page that scrolls under the finger.
 */


export function ImageManager({
  productId,
  productName,
  images,
  colourways,
  targetFill,
}: {
  productId: string;
  productName: string;
  images: AdminImage[];
  /** This product's real colourways, from its variants. See the upload panel. */
  colourways: readonly string[];
  /** The fraction the fill guide is drawn at, from the owner's settings. */
  targetFill: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  async function move(id: string, direction: "up" | "down" | "top") {
    setBusy("Reordering…");
    const result = await moveProductImage({ id, direction });
    setBusy(null);
    if (!result.ok) {
      toast.failed(result.message);
      return;
    }
    router.refresh();
  }

  return (
    <Panel
      title="Photographs"
      description="The first one leads the gallery and is the picture used on cards, in search and on the order."
    >
      <div className="mb-4">
        <ImageUploadPanel
          productId={productId}
          productName={productName}
          existingCount={images.length}
          colourways={colourways}
          targetFill={targetFill}
          onAdded={() => router.refresh()}
        />
      </div>

      {busy ? (
        <p className="text-muted-foreground mb-3 text-sm" aria-live="polite">
          {busy}
        </p>
      ) : null}

      {images.length === 0 ? (
        <EmptyState
          title="No photographs yet"
          body="A product with no picture still appears in the shop, as a grey box. Upload at least one — the first one you add becomes the main image."
        />
      ) : (
        <ol className="space-y-2">
          {images.map((image, index) => (
            <li
              key={image.id}
              className="border-border flex flex-wrap items-start gap-3 rounded-md border p-2.5"
            >
              {/* Decorative *here*: the position is announced by the chip
                  beside it and the description is in the editable box, so an
                  alt on this thumbnail would read the same text twice. */}
              <Image
                src={image.url}
                alt=""
                width={80}
                height={80}
                className="bg-muted size-20 shrink-0 rounded-sm object-cover"
              />

              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  {index === 0 ? (
                    <Chip tone="good">main picture</Chip>
                  ) : (
                    <Chip tone="neutral">{index + 1}</Chip>
                  )}
                  <ColourReach colour={image.color} colourways={colourways} />
                </div>
                <AltTextField
                  imageId={image.id}
                  value={image.altText ?? ""}
                  productName={productName}
                />
                <ColourField
                  imageId={image.id}
                  value={image.color}
                  colourways={colourways}
                />
              </div>

              {/*
                Full width and wrapping below `sm`, fixed-width above it.

                `shrink-0` alone put five controls on one line at 390px: the row
                could not shrink, so it grew past the card's own border and
                "Re-frame" was clipped with "Delete" hanging outside the box
                entirely. Every predicate in every gate passed — the buttons
                were present, visible and clickable — and a screenshot at 390
                caught it, which is the second time that has happened in this
                area and the reason audit:image-editor takes them.
              */}
              <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:shrink-0">
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={`Move photograph ${index + 1} up`}
                  disabled={index === 0 || busy !== null}
                  onClick={() => move(image.id, "up")}
                >
                  <ArrowUp className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={`Move photograph ${index + 1} down`}
                  disabled={index === images.length - 1 || busy !== null}
                  onClick={() => move(image.id, "down")}
                >
                  <ArrowDown className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={index === 0 || busy !== null}
                  onClick={() => move(image.id, "top")}
                >
                  <Star
                    className={cn("size-4", index === 0 && "fill-current")}
                    aria-hidden
                  />
                  Make main
                </Button>
                <RecropDialog
                  image={image}
                  position={index + 1}
                  targetFill={targetFill}
                  onDone={() => router.refresh()}
                />
                <ConfirmAction
                  subject={`Delete photograph ${index + 1}?`}
                  consequence={
                    index === 0 && images.length > 1
                      ? "It is the main picture, so the next one takes its place on cards and in search. The file is removed as well and cannot be recovered."
                      : "The file is removed as well and cannot be recovered."
                  }
                  confirmLabel="Delete it"
                  triggerLabel="Delete"
                  triggerVariant="ghost"
                  action={() => deleteProductImage({ id: image.id })}
                  successMessage="The photograph has gone"
                />
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/**
 * The description a screen reader reads, saved when the box loses focus.
 *
 * Blur rather than a Save button beside every photograph: ten photographs would
 * be ten buttons that all say the same word. It only writes when the text has
 * actually changed, so tabbing through the list costs nothing.
 */
function AltTextField({
  imageId,
  value,
  productName,
}: {
  imageId: string;
  value: string;
  productName: string;
}) {
  const router = useRouter();
  const [text, setText] = React.useState(value);
  const [saved, setSaved] = React.useState(value);
  const [pending, setPending] = React.useState(false);

  async function commit() {
    if (text.trim() === saved.trim() || pending) return;
    setPending(true);
    const result = await setImageAlt({ id: imageId, altText: text });
    setPending(false);
    if (!result.ok) {
      toast.failed(result.message);
      setText(saved);
      return;
    }
    setSaved(text);
    toast.done("Description saved");
    router.refresh();
  }

  return (
    <div>
      <label htmlFor={`alt-${imageId}`} className="sr-only">
        Description of this photograph
      </label>
      <Input
        id={`alt-${imageId}`}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        disabled={pending}
        maxLength={200}
        placeholder={`Describe it — blank reads as "${productName}"`}
        autoComplete="off"
      />
    </div>
  );
}

/**
 * Where this photograph is actually shown, said in words.
 *
 * The old version printed "{colour} only" when a colour was set and nothing at
 * all when it was not — so the state that caused the 2026-08-14 report, an
 * upload with no colour on a product whose colourways all have their own
 * photography, rendered as blank space. Blank space reads as "normal".
 *
 * Three states now, and the third is the one that did not exist:
 *
 *   - a colour this product still has → shown on that swatch, and on it alone;
 *   - no colour → shown on every swatch, which is what the storefront now does
 *     with an untagged image rather than only using it as a fallback;
 *   - a colour this product no longer has → **shown nowhere**. That is what a
 *     photograph tagged "Navy" looks like after Navy was deleted, and it is
 *     invisible on the shop with nothing to say so. The database trigger keeps
 *     a *rename* in step; a deleted colourway leaves this behind, and this line
 *     is how anybody finds out.
 */
function ColourReach({
  colour,
  colourways,
}: {
  colour: string | null;
  colourways: readonly string[];
}) {
  if (colour === null) {
    return (
      <span className="text-muted-foreground text-xs">
        shown on every colourway
      </span>
    );
  }
  if (!colourways.includes(colour)) {
    return (
      <Chip tone="bad">
        {colour} — this product has no such colourway, so it is shown nowhere
      </Chip>
    );
  }
  return (
    <span className="text-muted-foreground text-xs">
      shown on {colour} only
    </span>
  );
}

/**
 * The colourway control, saved on change rather than behind a button.
 *
 * A `<select>` has no equivalent of the alt box's blur-to-save: changing the
 * value *is* the decision, and a Save beside every photograph would be ten
 * buttons that all say the same word — the argument `AltTextField` already
 * makes one field up.
 *
 * It renders even on a single-colourway product, unlike the one on the upload
 * panel, and the asymmetry is deliberate: this list is where a photograph that
 * is already tagged gets corrected, including one tagged with a colourway that
 * has since been deleted, and hiding the control would leave that row with no
 * way back.
 */
function ColourField({
  imageId,
  value,
  colourways,
}: {
  imageId: string;
  value: string | null;
  colourways: readonly string[];
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  /**
   * A colour the product no longer has is still offered, as itself, so the
   * select can show what the row actually holds. Without it the control would
   * silently display "Every colourway" for a row that is tagged — and the first
   * unrelated edit would write that lie back.
   */
  const options =
    value !== null && !colourways.includes(value)
      ? [...colourways, value]
      : colourways;

  async function choose(next: string) {
    setPending(true);
    const result = await setImageColor({ id: imageId, color: next });
    setPending(false);
    if (!result.ok) {
      toast.failed(result.message);
      return;
    }
    toast.done(
      next ? `Filed under ${next}` : "Shown on every colourway",
    );
    router.refresh();
  }

  return (
    <div>
      <label htmlFor={`colour-${imageId}`} className="sr-only">
        Which colourway this photograph is of
      </label>
      <select
        id={`colour-${imageId}`}
        value={value ?? ""}
        disabled={pending}
        onChange={(event) => void choose(event.target.value)}
        className="border-input bg-background h-9 w-full rounded-sm border px-2 text-sm sm:max-w-[16rem]"
      >
        <option value="">Every colourway</option>
        {options.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </div>
  );
}
