"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { removeReview, restoreReview } from "@/lib/actions/admin/reviews";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

/**
 * Remove (with the reason the removal will be recorded under) and restore.
 *
 * The reason field appears inline when Remove is pressed rather than in a
 * window.prompt: the reason is a record the owner will read back later, and
 * a prompt teaches one-word answers. The action refuses a blank one anyway —
 * this is the same rule enforced twice.
 */
export function ReviewRowActions({
  reviewId,
  removed,
}: {
  reviewId: string;
  removed: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (removed) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await restoreReview({ reviewId });
            if (result.ok) {
              toast.success("Review restored — it is live again.");
              router.refresh();
            } else {
              toast.error(result.message);
            }
          })
        }
      >
        {pending ? "Restoring…" : "Restore"}
      </Button>
    );
  }

  if (!asking) {
    return (
      <Button variant="outline" size="sm" onClick={() => setAsking(true)}>
        Remove…
      </Button>
    );
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const result = await removeReview({ reviewId, reason });
          if (result.ok) {
            toast.success("Review removed. The row and your reason survive.");
            setAsking(false);
            setReason("");
            router.refresh();
          } else {
            toast.error(result.message);
          }
        });
      }}
    >
      <label className="sr-only" htmlFor={`remove-reason-${reviewId}`}>
        Why this review is being removed
      </label>
      <input
        id={`remove-reason-${reviewId}`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why? Recorded with the removal."
        // The field appears because the owner just asked for it; focus
        // follows their intent.
        autoFocus
        maxLength={500}
        className="border-border bg-background w-56 rounded-lg border px-2 py-1.5 text-sm"
      />
      <Button type="submit" variant="destructive" size="sm" disabled={pending}>
        {pending ? "Removing…" : "Remove"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setAsking(false)}
      >
        Keep it
      </Button>
    </form>
  );
}
