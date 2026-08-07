import { NextResponse } from "next/server";

import { getCart } from "@/lib/queries/cart";

/**
 * The bag, as JSON, for the drawer.
 *
 * The drawer is not rendered into every page: it would put a four-table join in
 * front of every render on the site for a panel most visits never open. It
 * fetches on open instead, through the same `getCart()` the /cart page renders
 * from — one source of truth, one set of revalidation rules, one place for the
 * arithmetic to live.
 *
 * `no-store`, and it must stay that way. This response is scoped to one
 * customer by RLS, and a shared cache holding it would hand one person's bag to
 * the next.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const cart = await getCart();
    return NextResponse.json(cart, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("[cart] GET /api/cart failed:", error);
    return NextResponse.json(
      { message: "Your bag could not be loaded." },
      { status: 500, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
