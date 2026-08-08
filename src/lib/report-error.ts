/**
 * What an error boundary says when it catches something.
 *
 * The first version of this logged `{ message, digest, stack }` and, in
 * production, printed `[storefront] unhandled error {}`. Two separate reasons,
 * and both had to be fixed:
 *
 * 1. **Every value can be undefined, and undefined keys do not survive
 *    serialisation.** `JSON.stringify({ message: undefined })` is `"{}"` — and
 *    so is `JSON.stringify(someError)`, because `message` and `stack` are
 *    non-enumerable on `Error`. Anything that forwards a browser log by
 *    serialising it (Next's own dev overlay bridge, a Vercel log drain, an
 *    error SDK) therefore received an empty object. Every field below is
 *    substituted to a present, non-empty string so the record cannot collapse.
 *
 * 2. **The real message is not available to the client, by design.** React
 *    strips a Server Component's error before it reaches the browser so that
 *    internals cannot leak to a customer; what arrives is a generic
 *    "Minified React error #…". The real error is in the *server* log, on the
 *    line carrying the same `digest`. Verified against a production build: a
 *    deliberate throw logged `Error: Deliberate throw … { digest: '676306073' }`
 *    on the server while the browser saw only the minified code and that digest.
 *
 * So the digest is not decoration, it is the join key between the two halves of
 * the same failure, and it is the one thing a customer can read off the screen
 * and quote. The headline carries the route and the digest as plain text, so
 * even a log pipeline that drops the structured half leaves something findable.
 */

/** Never emit undefined or "": a missing field must still be a visible field. */
function present(value: string | undefined, absent: string): string {
  return value !== undefined && value !== "" ? value : absent;
}

export type BoundaryError = Error & { digest?: string };

export function reportBoundaryError(
  /** Which boundary caught it — the two render very different pages. */
  boundary: "storefront" | "root",
  error: BoundaryError,
  /** From usePathname(); the query string is added here. */
  pathname: string,
): void {
  const route =
    typeof window === "undefined"
      ? pathname
      : `${pathname}${window.location.search}`;

  const digest = present(
    error.digest,
    "(none — thrown in the browser, so the message here is the real one)",
  );

  console.error(
    `[${boundary}] unhandled error at ${route}${error.digest ? ` · digest ${error.digest}` : ""}`,
    {
      boundary,
      route,
      digest,
      message: present(error.message, "(no message on the error)"),
      stack: present(
        error.stack,
        "(no stack — stripped from Server Component errors)",
      ),
      whereTheRealMessageIs: error.digest
        ? `Server log, on the line carrying digest ${error.digest}.`
        : "Here — a browser-thrown error is not stripped.",
    },
    // The live object as well, so devtools keeps it expandable and the stack
    // frames stay clickable. The record above is what survives being written
    // down; this is what is useful while you are standing in front of it.
    error,
  );
}
