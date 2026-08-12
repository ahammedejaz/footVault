"use client";

import { useState, useTransition } from "react";
import { Star } from "lucide-react";
import { toast } from "sonner";

import { submitReview } from "@/lib/actions/reviews";
import { cn } from "@/lib/utils";

/**
 * The review form, on the delivered order's page — the one place a customer
 * who can actually review is already standing.
 *
 * The star picker is a real radiogroup: five labelled radio inputs, keyboard
 * range semantics for free, each label a 44px target painting the stars up
 * to itself on hover and selection. A div with click handlers would look
 * identical and be unusable from a keyboard, which `audit:reachability`
 * would rightly refuse.
 */
export function ReviewForm({
  productId,
  productName,
}: {
  productId: string;
  productName: string;
}) {
  const [rating, setRating] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (done) {
    return (
      <p className="text-sm" role="status">
        {done}
      </p>
    );
  }

  const painted = hovered ?? rating ?? 0;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!rating) {
          toast.error("Pick a star rating first.");
          return;
        }
        startTransition(async () => {
          const result = await submitReview({
            productId,
            rating,
            title: title || undefined,
            body: body || undefined,
          });
          if (result.ok) {
            setDone(
              result.published
                ? "Thanks — your review is live on the product page."
                : "Thanks — your review is in and will appear once it is checked.",
            );
          } else {
            toast.error(result.message);
          }
        });
      }}
    >
      <fieldset>
        <legend className="font-mono text-xs tracking-[0.06em] uppercase">
          Your rating for {productName}
        </legend>
        <div
          role="radiogroup"
          aria-label="Star rating"
          className="mt-2 flex"
          onMouseLeave={() => setHovered(null)}
        >
          {[1, 2, 3, 4, 5].map((star) => (
            <label
              key={star}
              className="hit-44 relative cursor-pointer p-1"
              onMouseEnter={() => setHovered(star)}
            >
              <input
                type="radio"
                name="rating"
                value={star}
                checked={rating === star}
                onChange={() => setRating(star)}
                className="sr-only"
              />
              <Star
                aria-hidden
                className={cn(
                  "size-6 transition-colors",
                  star <= painted
                    ? "fill-foreground text-foreground"
                    : "fill-transparent text-border",
                )}
              />
              <span className="sr-only">
                {star} {star === 1 ? "star" : "stars"}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="mt-4 block">
        <span className="font-mono text-xs tracking-[0.06em] uppercase">
          Title <span className="text-muted-foreground normal-case">(optional)</span>
        </span>
        <input
          type="text"
          value={title}
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Fits true to size"
          className="border-border bg-background mt-1 block w-full rounded-lg border px-3 py-2 text-sm"
        />
      </label>

      <label className="mt-3 block">
        <span className="font-mono text-xs tracking-[0.06em] uppercase">
          Review <span className="text-muted-foreground normal-case">(optional)</span>
        </span>
        <textarea
          value={body}
          maxLength={2000}
          rows={4}
          onChange={(event) => setBody(event.target.value)}
          placeholder="How do they fit, feel, and hold up?"
          className="border-border bg-background mt-1 block w-full rounded-lg border px-3 py-2 text-sm"
        />
      </label>

      <button
        type="submit"
        disabled={pending}
        className="bg-ink text-paper hit-44 relative mt-4 rounded-lg px-4 py-2 font-mono text-xs tracking-[0.06em] uppercase disabled:opacity-60"
      >
        {pending ? "Saving…" : "Post review"}
      </button>
    </form>
  );
}
