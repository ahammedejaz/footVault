"use client";

import { useState, useTransition } from "react";
import { Heart } from "lucide-react";

import { SignInDialog } from "@/components/storefront/sign-in";
import { Button } from "@/components/ui/button";
import { toggleSaved } from "@/lib/actions/wishlist";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * Saving, from the product page and from a card.
 *
 * Optimistic: the heart fills on the tap, not on the round trip, and rolls back
 * with a visible message if the server disagrees. On a 4G phone the difference
 * between those two is the difference between a control that feels attached to
 * your finger and one that feels broken.
 *
 * Signed out, the tap is not refused — it opens a prompt and carries the intent
 * through the sign-in, so the shoe is saved when they land back here. The
 * intent travels in a cookie rather than the return URL, because a URL that
 * saves on arrival saves again on every refresh and back button.
 */
export function SaveForLater({
  productId,
  productName,
  saved,
  className,
  variant = "button",
}: {
  productId: string;
  productName: string;
  saved: boolean;
  className?: string;
  /** `button` on the product page, `icon` on a card. */
  variant?: "button" | "icon";
}) {
  // The server's answer is the starting point; `optimistic` takes over the
  // moment the customer acts, and is reset by the re-render that follows.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [prompting, setPrompting] = useState(false);
  const [, startTransition] = useTransition();

  const isSaved = optimistic ?? saved;

  const act = () => {
    const next = !isSaved;
    setOptimistic(next);

    startTransition(async () => {
      const result = await toggleSaved(productId);

      if (!result.ok) {
        setOptimistic(null);
        toast.failed(result.message);
        return;
      }

      if ("needsSignIn" in result.data) {
        setOptimistic(null);
        setPrompting(true);
        return;
      }

      // Settled: let the server's next render be the truth again.
      setOptimistic(null);
      if (result.data.saved) toast.done("Saved", productName);
      else toast.note("Removed from saved", productName);
    });
  };

  const label = isSaved
    ? `Remove ${productName} from saved items`
    : `Save ${productName}`;

  return (
    <>
      {variant === "icon" ? (
        <button
          type="button"
          onClick={act}
          aria-pressed={isSaved}
          aria-label={label}
          className={cn(
            "hit-44 bg-background/80 hover:bg-background absolute top-2 right-2 z-10 flex size-9 items-center justify-center rounded-full backdrop-blur transition-colors",
            className,
          )}
        >
          <Heart
            className={cn(
              "size-4 transition-colors",
              isSaved && "fill-orange text-orange",
            )}
            aria-hidden
          />
        </button>
      ) : (
        <Button
          type="button"
          size="lg"
          variant="outline"
          onClick={act}
          aria-pressed={isSaved}
          className={className}
        >
          <Heart
            className={cn("size-4", isSaved && "fill-orange text-orange")}
            aria-hidden
          />
          {isSaved ? "Saved" : "Save for later"}
        </Button>
      )}

      <SignInDialog
        open={prompting}
        onOpenChange={setPrompting}
        title="Sign in to save it"
        reason={`We will put ${productName} in your saved items as soon as you are back.`}
        intent={JSON.stringify({ kind: "save", productId })}
      />
    </>
  );
}
