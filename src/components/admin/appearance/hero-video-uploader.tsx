"use client";

import * as React from "react";

import { FieldLabel } from "@/components/admin/ui";
import { Input } from "@/components/ui/input";
import { requestVideoUploadSlot } from "@/lib/actions/admin/media";
import {
  ALLOWED_VIDEO_TYPES,
  formatBytes,
  HARD_MAX_BYTES,
  SITE_VIDEO_BUCKET,
  WARN_BYTES,
} from "@/lib/media/site-video";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";

/**
 * Choosing the hero's film, and being told what it costs before anyone else pays.
 *
 * ## Why the size is on screen and not in a rule
 *
 * The panel could simply refuse anything over 4MB and say so. It does not,
 * because the owner is the only person in this loop who knows whether this
 * particular ten seconds is worth it, and they cannot make that call against a
 * threshold they never see. So the moment a file is chosen — **before it is
 * uploaded, and long before it is published** — this reads the file's real size
 * off the `File` object and prints it: "6.2MB. Over the 4MB we aim for."
 *
 * The number stays on screen next to the field afterwards, so it is still there
 * when the owner reaches for Publish. A warning that scrolls away during the
 * work it is warning about is decoration.
 *
 * ## Two ceilings, two different sentences
 *
 * Over 4MB is a judgement and reads like one: it warns, it says what it means
 * for somebody on mobile data, and it uploads anyway.
 *
 * Over 10MB is a fact about the bucket, and refusing here is kinder than
 * letting Storage refuse it after the upload has crossed the wire. The server
 * re-checks the same number; this is the version that happens before the wait.
 *
 * ## The bytes do not go through the Server Action
 *
 * Same reason as photographs, only more so: Next caps a Server Action body at
 * 1MB and this bucket takes ten. The action authorises and mints a single-use
 * signed URL for one path; the file goes from the browser straight to Storage,
 * carrying the cache-control the action handed back. See media.ts.
 */
export function HeroVideoUploader({
  id,
  onUploaded,
}: {
  id: string;
  /** Receives the public URL. The editor writes it into the payload. */
  onUploaded: (url: string) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<{
    tone: "plain" | "warn" | "bad";
    text: string;
  } | null>(null);

  async function choose(file: File) {
    /*
      Read and report before anything else happens. Even in the refusal case
      below, the owner should be told the size they actually have rather than
      only the size they are allowed.
    */
    const size = formatBytes(file.size);

    if (file.size > HARD_MAX_BYTES) {
      setNote({
        tone: "bad",
        text: `${file.name} is ${size}. The storage bucket's own limit is ${formatBytes(HARD_MAX_BYTES)}, so this one cannot be uploaded at all. Export it shorter or at a lower bitrate.`,
      });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    const heavy = file.size > WARN_BYTES;
    setNote({
      tone: heavy ? "warn" : "plain",
      text: heavy
        ? `${size} — over the ${formatBytes(WARN_BYTES)} we aim for. It will work. On mobile data it is about ${mobileCost(file.size)} of a shopper's pack, spent before they have decided to buy anything.`
        : `${size}. Comfortably under the ${formatBytes(WARN_BYTES)} we aim for.`,
    });

    setBusy(true);
    const slot = await requestVideoUploadSlot({
      fileName: file.name,
      contentType: file.type,
      sizeBytes: file.size,
    });
    if (!slot.ok) {
      setBusy(false);
      setNote({ tone: "bad", text: slot.message });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    const supabase = createClient();
    const { error } = await supabase.storage
      .from(slot.bucket)
      .uploadToSignedUrl(slot.path, slot.token, file, {
        contentType: file.type,
        cacheControl: slot.cacheControl,
      });
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";

    if (error) {
      setNote({ tone: "bad", text: `That did not upload: ${error.message}` });
      return;
    }

    const { data } = supabase.storage
      .from(SITE_VIDEO_BUCKET)
      .getPublicUrl(slot.path);
    onUploaded(data.publicUrl);
    setNote({
      tone: heavy ? "warn" : "plain",
      text: `Uploaded — ${size}.${heavy ? ` Over the ${formatBytes(WARN_BYTES)} we aim for.` : ""} Nothing is live until you press Publish.`,
    });
    toast.done(
      "Video uploaded",
      "The address is in the field. Preview it, then Publish.",
    );
  }

  return (
    <div className="sm:col-span-2">
      <FieldLabel
        htmlFor={id}
        hint={`MP4 or WebM. Under ${formatBytes(WARN_BYTES)} keeps the shop quick; ${formatBytes(HARD_MAX_BYTES)} is the hard limit. The size is shown here before you publish.`}
      >
        Upload a hero video
      </FieldLabel>
      <Input
        id={id}
        ref={inputRef}
        type="file"
        accept={ALLOWED_VIDEO_TYPES.join(",")}
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void choose(file);
        }}
      />
      <p
        className={
          note?.tone === "bad"
            ? "text-destructive mt-1.5 min-h-5 text-xs text-pretty"
            : note?.tone === "warn"
              ? "mt-1.5 min-h-5 text-xs text-pretty text-amber-700 dark:text-amber-500"
              : "text-muted-foreground mt-1.5 min-h-5 text-xs text-pretty"
        }
        role="status"
        aria-live="polite"
      >
        {busy ? "Uploading…" : (note?.text ?? "")}
      </p>
    </div>
  );
}

/**
 * What the file costs a shopper, in the units they buy data in.
 *
 * ₹9 per GB is the going rate for a topped-up prepaid pack in India at the time
 * of writing, which is the shop's market. It is deliberately a rough number
 * shown to one decimal — the point is the order of magnitude, and a figure like
 * "₹0.0237" would read as precision this cannot honestly claim.
 */
function mobileCost(bytes: number): string {
  const rupees = (bytes / (1024 * 1024 * 1024)) * 9;
  return rupees < 0.1 ? "under ₹0.10" : `about ₹${rupees.toFixed(2)}`;
}
