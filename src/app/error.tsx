"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

import { TreadMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { reportBoundaryError, type BoundaryError } from "@/lib/report-error";

/**
 * The boundary for a route that fails outside the storefront group.
 *
 * An error inside the storefront is caught by (storefront)/error.tsx, which
 * keeps the header and footer. This one has no chrome to keep, so it renders
 * its own `main` rather than leaving the document without a landmark.
 *
 * It is **not** the last resort, despite what this comment used to say. An
 * error boundary catches throws from below it, and this file sits *inside* the
 * root layout — so a root layout that throws blows straight past it. That is
 * `app/global-error.tsx`, which exists now because production spent two hours
 * serving a bare 500 proving the point.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: BoundaryError;
  reset: () => void;
}) {
  const pathname = usePathname();
  useEffect(() => {
    // "root", not "storefront": both boundaries used to log the same label, so
    // a log line could not tell you whether the layout itself had failed.
    reportBoundaryError("root", error, pathname);
  }, [error, pathname]);

  return (
    <main className="mx-auto flex max-w-xl flex-col items-center px-4 py-24 text-center sm:px-6">
      <TreadMark className="text-line h-24 w-12" />
      <p className="text-muted-foreground mt-8 font-mono text-xs tracking-[0.06em] uppercase">
        Something failed
      </p>
      <h1 className="font-display mt-3 text-4xl font-extrabold tracking-[-0.03em] uppercase">
        This page did not load
      </h1>
      <p className="text-muted-foreground mt-4 text-base">
        Try again. If it keeps happening, contact us and quote the reference
        below.
      </p>
      {error.digest ? (
        <p className="text-muted-foreground mt-3 font-mono text-xs tracking-[0.06em]">
          Reference {error.digest}
        </p>
      ) : null}
      <div className="mt-8">
        <Button onClick={reset}>Try again</Button>
      </div>
    </main>
  );
}
