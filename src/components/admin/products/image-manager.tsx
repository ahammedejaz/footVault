"use client";

import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Star } from "lucide-react";

import { ConfirmAction } from "@/components/admin/confirm-action";
import { Chip, EmptyState, Panel } from "@/components/admin/ui";
import { ImageUploadPanel } from "@/components/admin/products/image-upload-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  deleteProductImage,
  moveProductImage,
  setImageAlt,
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
}: {
  productId: string;
  productName: string;
  images: AdminImage[];
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
                  {image.color ? (
                    <span className="text-muted-foreground text-xs">
                      {image.color} only
                    </span>
                  ) : null}
                </div>
                <AltTextField
                  imageId={image.id}
                  value={image.altText ?? ""}
                  productName={productName}
                />
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
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
