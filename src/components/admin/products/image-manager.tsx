"use client";

import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Star, Upload } from "lucide-react";

import { ConfirmAction } from "@/components/admin/confirm-action";
import { Chip, EmptyState, Panel } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  addProductImage,
  deleteProductImage,
  moveProductImage,
  setImageAlt,
} from "@/lib/actions/admin/products";
import { createClient } from "@/lib/supabase/client";
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

/** The bucket's own ceiling. Anything larger is rejected by storage anyway. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** Longest edge after compression. Bigger than any layout asks for. */
const MAX_EDGE = 1600;
const WEBP_QUALITY = 0.82;
const BUCKET = "product-images";
const ACCEPTED = ["image/jpeg", "image/png", "image/webp", "image/avif"];

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
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  async function upload(files: FileList) {
    const chosen = [...files];
    if (chosen.length === 0) return;

    let added = 0;
    for (const [index, file] of chosen.entries()) {
      setBusy(`Uploading ${index + 1} of ${chosen.length}…`);

      if (!ACCEPTED.includes(file.type)) {
        toast.failed(
          `${file.name} is a ${file.type || "kind of file"} the shop cannot use. JPEG, PNG, WebP or AVIF.`,
        );
        continue;
      }

      const prepared = await shrink(file);
      if (prepared.size > MAX_UPLOAD_BYTES) {
        toast.failed(
          `${file.name} is still ${Math.round(prepared.size / 1024 / 1024)}MB after compressing. Five megabytes is the limit.`,
        );
        continue;
      }

      const extension =
        prepared.type === "image/webp" ? "webp" : extensionOf(file.name);
      const path = `${productId}/${crypto.randomUUID()}.${extension}`;

      /**
       * Straight to storage from the browser, not through a Server Action.
       *
       * A Server Action body is one POST that Next caps at 1MB by default, and
       * a photograph from a phone is several times that. The upload is still
       * authorized — `admins upload storefront assets` re-checks `is_admin()`
       * inside Postgres against this session's own JWT — so nothing is being
       * trusted to the client except the bytes.
       */
      const supabase = createClient();
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(path, prepared, {
          contentType: prepared.type,
          cacheControl: "31536000",
          upsert: false,
        });

      if (error) {
        console.error("[admin] photograph upload failed:", error.message);
        toast.failed(`${file.name} did not upload. ${error.message}`);
        continue;
      }

      const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
      const result = await addProductImage({
        productId,
        url: data.publicUrl,
        // Deliberately blank rather than the file name. "IMG_4821.jpg" read out
        // by a screen reader is worse than the product name the storefront
        // falls back to, and a pre-filled box is a box nobody edits.
        altText: "",
      });

      if (!result.ok) {
        toast.failed(result.message);
        continue;
      }
      added += 1;
    }

    setBusy(null);
    if (inputRef.current) inputRef.current.value = "";
    if (added > 0) {
      toast.done(
        `${added} ${added === 1 ? "photograph" : "photographs"} added`,
        "Add a description to each one so the shop is readable without images.",
      );
      router.refresh();
    }
  }

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
      actions={
        <>
          {/* `hidden`, and a real <button> that clicks it. A `sr-only` input
              behind a <label> is the shorter version and it is a keyboard trap
              in reverse: the label cannot take focus, so the only focusable
              thing is an input nobody can see the focus ring on. */}
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED.join(",")}
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) void upload(event.target.files);
            }}
          />
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="size-4" aria-hidden />
            {busy === null ? "Upload" : "Working…"}
          </Button>
        </>
      }
    >
      <p className="text-muted-foreground mb-3 max-w-prose text-sm text-pretty">
        Pictures are shrunk to {MAX_EDGE}px and converted to WebP in this
        browser before they are sent, so a photograph straight off a phone does
        not cost a customer four megabytes to look at.
      </p>

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

/* --------------------------------------------------------------- shrinking -- */

/**
 * Downscale and re-encode in the browser, with no library.
 *
 * `createImageBitmap` plus a canvas is enough for what this needs, and adding a
 * compression dependency for it would be a package in every admin bundle to
 * save a few lines. Every failure path returns the original file rather than
 * throwing: a browser that cannot decode a particular photograph should still
 * be able to upload it, slowly, rather than refuse.
 *
 * The result is only used when it is actually smaller. Re-encoding an already
 * well-compressed JPEG as WebP can come out larger, and shipping a bigger file
 * than the owner chose would make this feature a cost rather than a saving.
 */
async function shrink(file: File): Promise<Blob> {
  if (typeof createImageBitmap !== "function") return file;

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/webp", WEBP_QUALITY);
    });

    if (!blob || blob.size >= file.size) return file;
    return blob;
  } catch (error) {
    console.warn("[admin] could not compress, sending the original:", error);
    return file;
  } finally {
    bitmap?.close();
  }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  const raw = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{2,5}$/.test(raw) ? raw : "jpg";
}
