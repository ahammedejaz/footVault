"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { TreadMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

type Hint = { name: string; category_slug: string | null; category_name: string | null };

/**
 * The 404 for a product that is no longer stocked.
 *
 * A shoe that sold out for good, or that the owner deactivated, still has links
 * pointing at it — from a search engine, from a bookmark, from a message
 * someone sent a friend. Dropping that person on a generic "nothing here" is
 * throwing away the one thing we know about them: which shelf they were
 * standing at.
 *
 * This is a Client Component because `not-found.tsx` is rendered without route
 * params, and the status code has to stay 404 — rendering this content from the
 * page instead would return 200 to a crawler and keep the dead URL indexed. So
 * the slug comes from the pathname, and the lookup goes through
 * `discontinued_product_hint`, a SECURITY DEFINER function that answers for one
 * slug and returns three fields (see migration 0016).
 *
 * The generic copy renders immediately; the specific line replaces it if the
 * lookup finds something. Nothing moves when it does — the paragraph is the
 * same two lines either way.
 */
export default function ProductNotFound() {
  const pathname = usePathname();
  const [hint, setHint] = React.useState<Hint | null>(null);

  React.useEffect(() => {
    const slug = pathname.split("/").filter(Boolean).pop();
    if (!slug) return;

    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await createClient()
          .rpc("discontinued_product_hint", { p_slug: slug })
          .maybeSingle();
        if (error) throw error;
        if (!cancelled && data) setHint(data as Hint);
      } catch (error) {
        // A failed hint is not worth showing anyone: the generic 404 below is
        // already a complete answer. It is worth logging.
        console.error("[404] discontinued product hint failed", error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center px-4 py-24 text-center sm:px-6">
      <TreadMark className="text-line h-24 w-12" />
      <p className="text-muted-foreground mt-8 font-mono text-xs tracking-[0.06em] uppercase">
        Error 404
      </p>
      <h1 className="font-display mt-3 text-4xl font-extrabold tracking-[-0.03em] text-balance uppercase">
        {hint ? "No longer stocked" : "This shoe is not here"}
      </h1>
      <p className="text-muted-foreground mt-4 min-h-[52px] text-base text-pretty">
        {hint ? (
          <>
            The {hint.name} has sold through and is not coming back.
            {hint.category_name ? ` The rest of ${hint.category_name} is still on the shelf.` : ""}
          </>
        ) : (
          "This product has moved or never existed. The catalogue is still where you left it."
        )}
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        {hint?.category_slug ? (
          <Button asChild>
            <Link href={`/shop/${hint.category_slug}`}>
              Browse {hint.category_name ?? "the category"}
            </Link>
          </Button>
        ) : (
          <Button asChild>
            <Link href="/shop">Shop all footwear</Link>
          </Button>
        )}
        <Button variant="outline" asChild>
          <Link href="/search">Search for something else</Link>
        </Button>
      </div>
    </div>
  );
}
