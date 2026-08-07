import Link from "next/link";

import { TreadMark } from "@/components/brand/logo";
import { StorefrontChrome } from "@/components/storefront/chrome";
import { Button } from "@/components/ui/button";

/**
 * The catch-all 404.
 *
 * Wearing the full storefront chrome on purpose: a customer who mistypes a URL
 * or follows a stale link should land somewhere that still has the navigation,
 * the search and the footer on it. A bare error card is a dead end, and it is
 * also a document with no `main` landmark.
 */
export default function NotFound() {
  return (
    <StorefrontChrome>
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
    </StorefrontChrome>
  );
}
