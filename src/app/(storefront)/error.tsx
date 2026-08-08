"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { TreadMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { reportBoundaryError, type BoundaryError } from "@/lib/report-error";

/**
 * An error inside the storefront.
 *
 * Scoped to the route group rather than the app root, so the header, the
 * navigation and the footer survive: whatever failed, the rest of the shop
 * still works and the customer should be able to walk to it.
 *
 * Errors say what broke and what to do, and never apologise. The digest is
 * shown because it is the one thing a customer can quote to support that
 * actually helps us find the failure in the logs.
 */
export default function StorefrontError({
  error,
  reset,
}: {
  error: BoundaryError;
  reset: () => void;
}) {
  const pathname = usePathname();
  useEffect(() => {
    reportBoundaryError("storefront", error, pathname);
  }, [error, pathname]);

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center px-4 py-24 text-center sm:px-6">
      <TreadMark className="text-line h-24 w-12" />
      <p className="text-muted-foreground mt-8 font-mono text-xs tracking-[0.06em] uppercase">
        Something failed
      </p>
      <h1 className="font-display mt-3 text-4xl font-extrabold tracking-[-0.03em] uppercase">
        This page did not load
      </h1>
      <p className="text-muted-foreground mt-4 text-base text-pretty">
        Try again. If it keeps happening, contact us and quote the reference
        below — it points straight at what went wrong.
      </p>
      {error.digest ? (
        <p className="text-muted-foreground mt-3 font-mono text-xs tracking-[0.06em]">
          Reference {error.digest}
        </p>
      ) : null}
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Button onClick={reset}>Try again</Button>
        <Button variant="outline" asChild>
          <Link href="/shop">Shop all footwear</Link>
        </Button>
      </div>
    </div>
  );
}
