"use client";

import * as React from "react";
import { ImageUp, Loader2, Pencil, Trash2 } from "lucide-react";

import { FrameStage } from "@/components/admin/site-images/frame-stage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  clearSiteImage,
  requestSiteImageUpload,
  reframeSiteImage,
  saveSiteImage,
} from "@/lib/actions/admin/site-images";
import { DEFAULT_FRAMING, type Framing } from "@/lib/images/frame";
import type { SiteImageValue } from "@/lib/images/site-image";
import {
  ALLOWED_SOURCE_TYPES,
  aspectOf,
  IMAGE_FRAMES,
  MAX_SOURCE_BYTES,
  SITE_ASSET_BUCKET,
  type FrameKey,
} from "@/lib/images/site-frames";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";

/**
 * One picture, in one place on the site.
 *
 * This is the single control behind every image the owner can change: the hero,
 * the department tiles, the banner, the logo, the favicon, the share card, a
 * brand's mark. They were seven different arrangements before — five of them a
 * text box you pasted a URL into, one a file input with no framing, one a PNG
 * committed to the repository — and being seven arrangements is most of why
 * only one of them ever got used.
 *
 * ## The whole interaction is three verbs
 *
 * **Choose** puts a picture there. **Adjust** decides which part of it shows.
 * **Remove** takes it away. Nothing else is on screen, because everything else
 * an image control could offer — a media browser, a URL field, a format choice,
 * an aspect selector — is a decision the shop has already made and does not
 * need the owner to re-make.
 *
 * Choosing renders immediately with the plain centred crop, so the common case
 * is one press and the picture is live. Adjusting is a second, optional step
 * the owner reaches for when the centre is not where the interesting part is.
 * The alternative — making them frame it before they can see it — puts a
 * decision in front of the result on every single upload.
 *
 * ## Adjust expands in place. It is not a dialog.
 *
 * Framing is a two-handed drag, and this panel is used on a phone standing in a
 * shop. A modal on a touch screen is a layer that swallows the drag at its
 * edges and traps focus somewhere the sliders are not. The product re-crop tool
 * reached the same conclusion and says so in its own header; this follows it.
 *
 * ## What this does not do
 *
 * It does not save the surrounding form. `onChange` hands the URL to whichever
 * form owns the field — a category, a homepage section, the branding panel —
 * and that form saves it with everything else on it, so changing a
 * department's picture and its name is one Save and one Cancel. The picture
 * itself is stored the moment it is framed, which is the honest trade: an
 * abandoned form leaves an unreferenced file in the bucket that `/admin/media`
 * can see, rather than a half-uploaded picture that has to be re-sent.
 */

export type { SiteImageValue };

export function SiteImageField({
  slot,
  frame,
  initial,
  onChange,
  label,
  hint,
  fallbackUrl,
  fallbackNote,
  disabled,
  showAlt = true,
}: {
  slot: string;
  frame: FrameKey;
  /** What is already in this place, or null. */
  initial: SiteImageValue;
  /** The rendered URL, or null when the owner has removed the picture. */
  onChange: (url: string | null, alt: string | null) => void;
  /** Overrides the preset's own label, where the surface says it better. */
  label?: string;
  hint?: string;
  /**
   * A picture arriving from somewhere the owner cannot edit — today, the hero's
   * `banners` row, which supplied its still long before this field existed.
   *
   * Shown greyed with `fallbackNote` under it rather than hidden, because the
   * alternative is an empty box on a page that is visibly not empty, and an
   * owner who cannot see where a picture comes from cannot replace it on
   * purpose.
   */
  fallbackUrl?: string | null;
  fallbackNote?: string;
  disabled?: boolean;
  showAlt?: boolean;
}) {
  const spec = IMAGE_FRAMES[frame];
  const fieldId = React.useId().replace(/:/g, "");
  const inputRef = React.useRef<HTMLInputElement>(null);

  const [value, setValue] = React.useState<SiteImageValue>(initial);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [adjusting, setAdjusting] = React.useState(false);
  const [draft, setDraft] = React.useState<Framing>(
    initial?.framing ?? DEFAULT_FRAMING,
  );
  const [note, setNote] = React.useState<string | null>(null);

  const aspect = aspectOf(frame);

  /**
   * The untouched upload's public URL, which is what the stage drags.
   *
   * Read off the current value rather than memoised on a conditional property:
   * `getPublicUrl` is pure string assembly with no network call, so recomputing
   * it on a render costs less than the compiler has to reason about to keep a
   * memo whose dependency may be undefined.
   */
  const originalPath = value?.originalPath ?? null;
  const originalUrl = originalPath
    ? createClient().storage.from(SITE_ASSET_BUCKET).getPublicUrl(originalPath)
        .data.publicUrl
    : null;

  /* ------------------------------------------------------------ choose --- */

  async function onFile(file: File) {
    setNote(null);

    /*
      Both checks happen again on the server and in the bucket. They are here
      because the owner is standing in the shop holding the file: being told
      "that is 8MB, export it smaller" before a minute of upload is a different
      experience from being told it after.
    */
    if (!(ALLOWED_SOURCE_TYPES as readonly string[]).includes(file.type)) {
      toast.failed(
        "Pictures only — JPEG, PNG, WebP or AVIF. A PDF or an SVG will not do.",
      );
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      toast.failed(
        `That picture is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_SOURCE_BYTES)} — export it smaller and try again.`,
      );
      return;
    }

    setBusy("Uploading…");
    try {
      const slotResult = await requestSiteImageUpload({
        slot,
        frame,
        fileName: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      });
      if (!slotResult.ok) {
        toast.failed(slotResult.message);
        return;
      }

      const { error } = await createClient()
        .storage.from(slotResult.bucket)
        .uploadToSignedUrl(slotResult.path, slotResult.token, file, {
          contentType: file.type,
        });
      if (error) {
        toast.failed(
          "The upload did not finish. Check the connection and try again.",
        );
        return;
      }

      setBusy("Framing…");
      const saved = await saveSiteImage({
        slot,
        frame,
        originalPath: slotResult.path,
        // The plain centred crop. Adjust is one press away for anyone who
        // wants a different part of the picture.
        framing: DEFAULT_FRAMING,
        alt: value?.alt ?? null,
      });
      if (!saved.ok) {
        toast.failed(saved.message);
        return;
      }

      const next: SiteImageValue = {
        url: saved.url,
        originalPath: saved.originalPath,
        sourceWidth: saved.sourceWidth,
        sourceHeight: saved.sourceHeight,
        framing: saved.framing,
        alt: value?.alt ?? null,
      };
      setValue(next);
      setDraft(saved.framing);
      onChange(saved.url, next.alt);
      setNote(
        saved.upscaled
          ? `That picture is ${saved.sourceWidth}×${saved.sourceHeight}, smaller than the ${spec.width}×${spec.height} this place needs — it will look soft. A larger one would be sharper.`
          : null,
      );
      toast.done("Picture in place.");
    } finally {
      setBusy(null);
      // So choosing the same file twice in a row still fires a change event.
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  /* ------------------------------------------------------------ adjust --- */

  async function applyFraming() {
    setBusy("Framing…");
    try {
      const saved = await reframeSiteImage({ slot, framing: draft, alt: value?.alt ?? null });
      if (!saved.ok) {
        toast.failed(saved.message);
        return;
      }
      setValue((current) =>
        current ? { ...current, url: saved.url, framing: saved.framing } : current,
      );
      setDraft(saved.framing);
      onChange(saved.url, value?.alt ?? null);
      setAdjusting(false);
      toast.done("Framing saved.");
    } finally {
      setBusy(null);
    }
  }

  /* ------------------------------------------------------------ remove --- */

  async function remove() {
    setBusy("Removing…");
    try {
      const result = await clearSiteImage({ slot });
      if (!result.ok) {
        toast.failed(result.message);
        return;
      }
      setValue(null);
      setDraft(DEFAULT_FRAMING);
      setAdjusting(false);
      setNote(null);
      onChange(null, null);
    } finally {
      setBusy(null);
    }
  }

  /* ----------------------------------------------------------- render ---- */

  const shown = value?.url ?? fallbackUrl ?? null;
  const isFallback = !value?.url && Boolean(fallbackUrl);

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium">{label ?? spec.label}</p>
        <p className="text-muted-foreground mt-0.5 text-sm">{hint ?? spec.hint}</p>
      </div>

      {/*
        The preview is drawn at the frame's own shape, always — including when
        it is empty. An owner deciding whether a photograph suits the hero is
        deciding about a 16:9 band, and showing them a square placeholder that
        becomes a band later is showing them the wrong question.

        `max-w-md` keeps a 16:9 hero from swallowing a settings page on a
        desktop while still filling the width of a phone, where these are
        actually used.
      */}
      <div
        style={{ aspectRatio: String(aspect) }}
        className={[
          "relative w-full max-w-md overflow-hidden rounded-lg border",
          spec.mode === "contain" ? "bg-muted" : "bg-photo",
          shown ? "border-border" : "border-border border-dashed",
        ].join(" ")}
      >
        {shown ? (
          /* A plain <img>: these are already cut to the exact pixel size the
             page uses, so the optimiser has nothing left to do, and routing an
             admin preview through it would cost a transform per reload. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={shown}
            alt=""
            className={[
              "absolute inset-0 size-full",
              spec.mode === "contain" ? "object-contain p-3" : "object-cover",
              isFallback ? "opacity-70" : "",
            ].join(" ")}
          />
        ) : (
          <div className="text-muted-foreground absolute inset-0 grid place-items-center px-4 text-center text-sm">
            Nothing here yet — {spec.width}×{spec.height} or larger looks best.
          </div>
        )}

        {busy ? (
          <div className="bg-background/70 absolute inset-0 grid place-items-center gap-2 text-sm font-medium">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {busy}
            </span>
          </div>
        ) : null}
      </div>

      {isFallback && fallbackNote ? (
        <p className="text-muted-foreground text-sm">{fallbackNote}</p>
      ) : null}

      {/*
        Wrapping row, and every control is a real button at touch size. On a
        390px screen these stack to two rows rather than shrinking, because a
        36px button in a shop with wet hands is a button that gets pressed
        twice.
      */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          id={`${fieldId}-file`}
          type="file"
          accept={ALLOWED_SOURCE_TYPES.join(",")}
          className="sr-only"
          disabled={disabled || busy !== null}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onFile(file);
          }}
        />
        {/*
          A <label> styled as the button rather than a button that clicks a
          hidden input. The native association means a screen reader announces
          "Choose picture, file upload" and the keyboard reaches it without any
          JavaScript standing in the way.
        */}
        <Button asChild variant="outline" size="sm" disabled={disabled || busy !== null}>
          <label htmlFor={`${fieldId}-file`} className="cursor-pointer">
            <ImageUp className="size-4" aria-hidden />
            {value ? "Replace picture" : "Choose picture"}
          </label>
        </Button>

        {value ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || busy !== null}
              onClick={() => {
                setDraft(value.framing);
                setAdjusting((open) => !open);
              }}
              aria-expanded={adjusting}
            >
              <Pencil className="size-4" aria-hidden />
              {adjusting ? "Close adjuster" : "Adjust"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || busy !== null}
              onClick={() => void remove()}
            >
              <Trash2 className="size-4" aria-hidden />
              Remove
            </Button>
          </>
        ) : null}
      </div>

      {note ? <p className="text-muted-foreground text-sm">{note}</p> : null}

      {adjusting && value && originalUrl ? (
        <div className="border-border bg-muted/40 space-y-3 rounded-lg border p-3">
          <FrameStage
            src={originalUrl}
            source={{ width: value.sourceWidth, height: value.sourceHeight }}
            aspect={aspect}
            framing={draft}
            onChange={setDraft}
            disabled={busy !== null}
            label={label ?? spec.label}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy !== null}
              onClick={() => void applyFraming()}
            >
              Use this framing
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => {
                setDraft(value.framing);
                setAdjusting(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setDraft(DEFAULT_FRAMING)}
            >
              Centre it
            </Button>
          </div>
        </div>
      ) : null}

      {showAlt && value ? (
        <div>
          <label
            htmlFor={`${fieldId}-alt`}
            className="mb-1 block text-sm font-medium"
          >
            Description for screen readers{" "}
            <span className="text-muted-foreground font-normal">(optional)</span>
          </label>
          <Input
            id={`${fieldId}-alt`}
            value={value.alt ?? ""}
            maxLength={200}
            disabled={disabled || busy !== null}
            placeholder="What is in the picture"
            onChange={(event) => {
              const alt = event.target.value;
              setValue((current) => (current ? { ...current, alt } : current));
              onChange(value.url, alt);
            }}
          />
          <p className="text-muted-foreground mt-1 text-sm">
            Leave it empty when the picture only decorates words that are
            already on screen — a reader announcing the department twice is
            worse than silence.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** "2.6MB", "870KB" — the size, as the owner should read it. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
