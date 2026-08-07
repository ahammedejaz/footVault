"use client";

import { useEffect } from "react";

import { TreadMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

/**
 * Errors say what broke and what to do, and never apologise. The digest is
 * shown because it is the one thing a customer can quote to support that
 * actually helps us find the failure in the logs.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[storefront] unhandled error", {
      message: error.message,
      digest: error.digest,
      stack: error.stack,
    });
  }, [error]);

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center px-4 py-24 text-center sm:px-6">
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
    </div>
  );
}
