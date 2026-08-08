"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { FieldLabel } from "@/components/admin/ui";
import { Input } from "@/components/ui/input";
import { requestUploadSlot } from "@/lib/actions/admin/media";
import { createClient } from "@/lib/supabase/client";
import { toast } from "@/lib/toast";

/**
 * Uploading photographs.
 *
 * **The file does not go through the Server Action.** Next caps a Server
 * Action's request body at 1MB by default — under half of what a phone camera
 * produces, and a fifth of what this bucket accepts — and the failure is a
 * generic error with nothing in it about size. So the action authorises
 * (`adminAction` → `is_admin()` in the database) and hands back a single-use
 * signed URL for one specific path, and the bytes go from here straight to
 * Storage. The upload is still admin-only: the token is minted server-side by a
 * caller the database has verified, and the bucket re-checks type and size on
 * arrival.
 *
 * **A real `<input type="file">`, not a button over a hidden one.** It is
 * focusable, it opens the picker on Enter, it announces the selected count, and
 * on a tablet it offers the camera. The panel's `Input` already styles the
 * `file:` pseudo-element, so this costs nothing to keep native.
 *
 * Files upload one at a time rather than in parallel. Shop wifi is the target,
 * and six 4MB uploads at once is how a connection produces six timeouts instead
 * of six photographs.
 */
export function MediaUploader({
  prefix,
  maxBytes,
  acceptTypes,
}: {
  /** The folder being browsed, so an upload lands where the owner is looking. */
  prefix: string;
  maxBytes: number;
  acceptTypes: readonly string[];
}) {
  const router = useRouter();
  const inputId = React.useId();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [status, setStatus] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function upload(files: FileList) {
    setBusy(true);
    const chosen = [...files];
    let done = 0;
    const failures: string[] = [];
    const supabase = createClient();

    for (const file of chosen) {
      setStatus(`Uploading ${file.name} — ${done + 1} of ${chosen.length}`);

      if (file.size > maxBytes) {
        failures.push(
          `${file.name} is over ${Math.round(maxBytes / 1048576)}MB`,
        );
        continue;
      }

      const slot = await requestUploadSlot({
        fileName: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        prefix,
      });
      if (!slot.ok) {
        failures.push(`${file.name}: ${slot.message}`);
        continue;
      }

      const { error } = await supabase.storage
        .from(slot.bucket)
        .uploadToSignedUrl(slot.path, slot.token, file, {
          contentType: file.type,
        });
      if (error) {
        failures.push(`${file.name}: ${error.message}`);
        continue;
      }
      done += 1;
    }

    setBusy(false);
    setStatus(null);
    if (inputRef.current) inputRef.current.value = "";

    if (done > 0) {
      toast.done(
        `${done} photograph${done === 1 ? "" : "s"} uploaded`,
        "Copy the address of one to use it on a product or a brand.",
      );
      router.refresh();
    }
    for (const failure of failures.slice(0, 3)) toast.failed(failure);
    if (failures.length > 3) {
      toast.failed(`${failures.length - 3} more did not upload.`);
    }
  }

  return (
    <div className="sm:max-w-sm">
      <FieldLabel
        htmlFor={inputId}
        hint={`JPEG, PNG, WebP or AVIF, up to ${Math.round(maxBytes / 1048576)}MB each.${prefix ? ` They go into ${prefix}.` : ""}`}
      >
        Add photographs
      </FieldLabel>
      <Input
        id={inputId}
        ref={inputRef}
        type="file"
        multiple
        accept={acceptTypes.join(",")}
        disabled={busy}
        onChange={(event) => {
          const files = event.target.files;
          if (files && files.length > 0) void upload(files);
        }}
      />
      <p
        className="text-muted-foreground mt-1 min-h-5 text-xs"
        role="status"
        aria-live="polite"
      >
        {status ?? ""}
      </p>
    </div>
  );
}
