import type { Instrumentation } from "next";

/**
 * Every server error, in one place.
 *
 * `onRequestError` is the only hook that sees all of them — a throw while
 * rendering a Server Component, inside a Route Handler, inside a Server Action,
 * or in the proxy. Wiring the error boundaries instead would catch the render
 * case and miss the other three, and the ones it misses are the ones that
 * happen while a customer is paying.
 *
 * Until this file existed, a server error reached the platform runtime log and
 * stopped there — a log nobody opens unless they already know something is
 * wrong, which is the one thing an error report exists to tell them. When
 * `NEXT_PUBLIC_SUPABASE_URL` was missing on Vercel, that cost two hours and 106
 * visitors, and it was a human loading the site who noticed, not the system.
 *
 * ## Why the work is behind a dynamic import
 *
 * This file is loaded in **both** runtimes. The reporter reaches the database
 * (for the rate limiter) and imports `server-only` modules, none of which
 * belong in an edge bundle; a static import would pull that graph into the
 * edge build whether or not it ever runs. The runtime check plus `await import`
 * keeps the edge copy of this file to the two lines below.
 *
 * ## What this deliberately does not do
 *
 * It does not swallow, re-throw, or alter the error. Next has already decided
 * what the customer sees — `error.tsx`, or `global-error.tsx` when the root
 * layout is what failed. This is a tap on the wire, and a tap that changes the
 * signal is a bug.
 */
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { reportServerError } = await import(
    "@/lib/errors/report-server-error"
  );

  /*
    `request.path` carries the query string, and a query string on this shop
    can hold a search term or a pin code. The path alone identifies the failure
    and the route identifies the code; the query adds nothing an owner acts on
    and is the kind of thing that quietly ends up in an inbox forever.
  */
  await reportServerError({
    error,
    path: request.path.split("?")[0] ?? request.path,
    method: request.method,
    routePath: context.routePath,
    routeType: context.routeType,
  });
};
