import { NextResponse } from "next/server";

/**
 * A real 404 for any `/api/*` path that has no handler.
 *
 * Without this, Next answers a **POST** to a non-existent API route with the
 * not-found *page* and **HTTP 200**. Measured on production, before this file
 * existed:
 *
 * ```
 * GET  /api/anything-missing  → 404   (correct)
 * POST /api/anything-missing  → 200   (a soft 404, with an HTML body)
 * PUT  /api/anything-missing  → 200
 * ```
 *
 * For a page that is a search-ranking problem. For an API it is a data-loss
 * problem, and this project came within one configuration step of proving it:
 * the Razorpay webhook lives at `/api/payments/razorpay/webhook`, that route did
 * not exist in the production deployment, and the owner was about to register
 * the URL with Razorpay.
 *
 * Razorpay POSTs. It treats any 2xx as "delivered, done" and stops; it retries
 * non-2xx with backoff for about a day. So a 200 from a route that does not
 * exist would have made Razorpay discard every `payment.captured` **on the first
 * attempt**, with no error raised anywhere, leaving paid orders sitting in
 * `pending` until the abandoned-order sweep cancelled and restocked them. A
 * customer charged, with no order. The retry mechanism that normally covers a
 * missing endpoint is precisely what a 200 defeats.
 *
 * The catch-all costs nothing — it only runs where no real handler matched — and
 * it protects every webhook this project adds later, not just Razorpay's.
 *
 * `Cache-Control: no-store` because a cached 404 for an endpoint that is about
 * to be deployed is its own small trap.
 */

export const dynamic = "force-dynamic";

function notFound(): NextResponse {
  return NextResponse.json(
    { error: "Not found" },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const HEAD = notFound;
export const OPTIONS = notFound;
