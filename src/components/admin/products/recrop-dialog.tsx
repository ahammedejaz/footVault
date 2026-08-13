"use client";

import * as React from "react";
import { Crop as CropIcon, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  CropControls,
  CropStage,
  type Frame,
  type Subject,
} from "@/components/admin/products/crop-stage";
import {
  proposeFrame,
  recropImage,
} from "@/lib/actions/admin/image-pipeline";
import { DEFAULT_CROP, normaliseCrop, type Crop } from "@/lib/images/crop";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";
import type { AdminImage } from "@/components/admin/products/types";

/**
 * Re-framing a photograph that is already on the product, without re-uploading
 * it.
 *
 * ## Why this exists at all
 *
 * The original is kept precisely so a framing decision is never final. Without
 * this, "that one is cropped too tight" means walking back to the shelf,
 * finding the shoe, photographing it again, and describing it again — for a
 * mistake that is six numbers wide.
 *
 * ## It opens on the framing that produced what is on screen
 *
 * Not on a fresh auto-frame. The owner came here because they disagree with a
 * *specific* result, and starting them somewhere else would make the change
 * they wanted to make impossible to see. `Frame it for me` is one press away
 * when they do want the detector's opinion.
 *
 * ## Inline rather than a modal
 *
 * A crop is a two-handed gesture on a tablet, and a dialog on a tablet is a
 * layer that eats the drag at its edges and traps focus somewhere the sliders
 * are not. This expands in place, under the photograph it is about, and closes
 * to exactly where the owner was.
 */
export function RecropDialog({
  image,
  position,
  targetFill,
  onDone,
}: {
  image: AdminImage;
  /** Its place in the gallery, so every label on screen is distinguishable. */
  position: number;
  targetFill: number;
  onDone: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [crop, setCrop] = React.useState<Crop>(() => normaliseCrop(image.crop));
  const [frame, setFrame] = React.useState<Frame | null>(null);
  const [subject, setSubject] = React.useState<Subject | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  /** The untouched upload, which is what the square is dragged over. */
  const originalUrl = React.useMemo(() => {
    if (!image.originalPath) return null;
    return createClient()
      .storage.from("product-images")
      .getPublicUrl(image.originalPath).data.publicUrl;
  }, [image.originalPath]);

  async function measure(rotation: number, keepFraming = true) {
    if (!image.originalPath) return;
    setLoading(true);
    const result = await proposeFrame({
      path: image.originalPath,
      rotation,
    });
    setLoading(false);
    if (!result.ok) {
      toast.failed(result.message);
      return;
    }
    setFrame(result.frame);
    setSubject(result.subject);
    if (!keepFraming) {
      setCrop((prev) => ({
        ...result.crop,
        rotation: prev.rotation,
        brightness: prev.brightness,
        contrast: prev.contrast,
      }));
    }
  }

  async function begin() {
    setOpen(true);
    setCrop(normaliseCrop(image.crop));
    // Measured before anything is drawn: the frame's dimensions are what every
    // fraction is a fraction of, and guessing them from the derivative would
    // measure the square we already cut rather than the photograph.
    await measure(normaliseCrop(image.crop).rotation);
  }

  async function save() {
    setBusy(true);
    const result = await recropImage({ imageId: image.id, crop });
    setBusy(false);
    if (!result.ok) {
      toast.failed(result.message);
      return;
    }
    toast.done("Re-framed", "The product now shows the new crop.");
    setOpen(false);
    onDone();
  }

  /**
   * A photograph with no original cannot be re-framed, and the button says so
   * instead of disappearing. A control that vanishes teaches nothing; this one
   * explains, once, why this particular picture is different — and what to do.
   */
  if (!image.originalPath) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          toast.failed(
            "No original was kept for this one, so it cannot be re-framed. Upload it again and it will be framed from the start.",
          )
        }
      >
        <CropIcon className="size-4" aria-hidden />
        Re-frame
      </Button>
    );
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => void begin()}>
        <CropIcon className="size-4" aria-hidden />
        Re-frame
      </Button>
    );
  }

  return (
    <div className="border-border bg-card mt-2 w-full space-y-3 rounded-md border p-3">
      <p className="text-sm font-medium">Re-framing photograph {position}</p>

      <div className="grid gap-4 sm:grid-cols-[minmax(14rem,20rem)_1fr]">
        {frame && originalUrl ? (
          <CropStage
            src={originalUrl}
            frame={frame}
            crop={crop}
            subject={subject}
            targetFill={targetFill}
            disabled={busy}
            onChange={setCrop}
          />
        ) : (
          <div className="bg-fog grid aspect-square w-full place-items-center rounded-lg">
            <Loader2 className="text-muted-foreground size-5 animate-spin" aria-hidden />
          </div>
        )}

        <div className="space-y-3">
          <CropControls
            crop={crop}
            disabled={busy || !frame}
            onChange={(next) => {
              const straightened = next.rotation !== crop.rotation;
              setCrop(next);
              if (straightened) void measure(next.rotation);
            }}
          />

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || !frame}
              onClick={() => void save()}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : null}
              Save this framing
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || loading}
              onClick={() => void measure(crop.rotation, false)}
            >
              Frame it for me
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setCrop({ ...DEFAULT_CROP, rotation: crop.rotation })}
            >
              Whole photograph
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
