import Link from "next/link";

import { TreadMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

/**
 * The 404 copy, without any chrome around it.
 *
 * Shared by two files that need the same words and *different* wrappers, which
 * is the whole reason it exists. `src/app/not-found.tsx` is reached from
 * outside the storefront route group, where there is no layout to supply a
 * header and footer, so it wraps this in `StorefrontChrome`.
 * `src/app/(storefront)/not-found.tsx` is reached from inside that group, where
 * the layout has already rendered the chrome, so it renders this bare.
 *
 * Without the second file, Next falls back to the root one for both — and a
 * `notFound()` from inside the group renders the full chrome *inside* the full
 * chrome. Measured on `/order/FV-2026-99999` before the fix: two `<main>`
 * elements (one nested in the other), two `<header>`, two `<footer>`, eight
 * `<nav>`, two `id="main"` and two skip links. Three separate axe landmark
 * violations, and a screen reader offered two documents to navigate.
 */
export function NotFoundBody() {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center px-4 py-24 text-center sm:px-6">
      <TreadMark className="text-line h-24 w-12" />
      <p className="text-muted-foreground mt-8 font-mono text-xs tracking-[0.06em] uppercase">
        Error 404
      </p>
      <h1 className="font-display mt-3 text-4xl font-extrabold tracking-[-0.03em] uppercase">
        Nothing here
      </h1>
      <p className="text-muted-foreground mt-4 text-base text-pretty">
        This page has moved or never existed. The catalogue is still where you left
        it.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Button asChild>
          <Link href="/shop">Shop all footwear</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/search">Search</Link>
        </Button>
      </div>
    </div>
  );
}
