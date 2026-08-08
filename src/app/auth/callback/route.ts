import { NextResponse, type NextRequest } from "next/server";

import { mergeGuestCartIntoAccount } from "@/lib/cart/merge";
import { adoptGuestOrders } from "@/lib/orders/adopt";
import { clearGuestToken, readGuestToken } from "@/lib/cart/token";
import { takePendingIntent } from "@/lib/pending-intent";
import { saveProduct } from "@/lib/actions/wishlist";
import { safeNext } from "@/lib/safe-redirect";
import { createClient } from "@/lib/supabase/server";

/**
 * Where Google sends the customer back to.
 *
 * Supabase's SSR client uses PKCE, so what arrives here is a single-use code,
 * not a token. Exchanging it server-side is what writes the session cookies —
 * which is the whole reason this is a route handler and not a page: a Server
 * Component cannot set a cookie, so a page here would authenticate the customer
 * and then lose the session on the redirect.
 *
 * Everything that must happen exactly once at the moment of signing in belongs
 * here, in this order:
 *
 *   1. exchange the code for a session
 *   2. merge the guest bag into the account's bag        (src/lib/cart/merge.ts)
 *   3. move the guest's *orders* onto the account        (adopt_guest_orders)
 *   4. finish whatever the customer was trying to do     (src/lib/pending-intent.ts)
 *
 * 2, 3 and 4 run *after* the session exists, so all three act as the signed-in
 * user and all three are covered by the same RLS policies as any other request.
 *
 * Step 3 is not optional and it is not a nicety. The confirmation page for a
 * guest order invites the customer to create an account; before this existed,
 * accepting that invitation destroyed their access to the order they had just
 * paid for. The cart merge reports a checked-out cart as "spent" (it looks for
 * an *active* bag and a converted one is not that), the cookie is dropped on
 * the strength of it, and the order was left carrying a token no browser held
 * any more — unreadable by the guest policy, unreadable by the customer policy,
 * unreachable forever. Adoption has to happen before the cookie goes, in the
 * same request, on this same client: it is the only moment that carries both
 * the new session and the old guest token at once.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"));

  // The customer pressed "cancel" on Google's consent screen, or the provider
  // returned an error. Neither is a fault worth a stack trace; send them back
  // to where they were.
  const providerError = url.searchParams.get("error");
  if (providerError) {
    console.warn(
      `[auth] provider returned ${providerError}: ${url.searchParams.get("error_description") ?? ""}`,
    );
    return NextResponse.redirect(
      new URL(`${next}${joiner(next)}signin=cancelled`, url.origin),
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL(`${next}${joiner(next)}signin=failed`, url.origin),
    );
  }

  // Built before the exchange, and deliberately so: it captures the guest token
  // cookie into the `x-guest-token` header it sends to PostgREST, and picks up
  // the new session in memory once the exchange completes. That is what lets
  // one client see the anonymous bag and the account bag at the same time,
  // which is what the merge below needs.
  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.session) {
    // A code is single-use and short-lived, so the usual cause is a reload of
    // this URL rather than an attack.
    console.error(
      "[auth] exchangeCodeForSession failed:",
      error?.message ?? "no session",
    );
    return NextResponse.redirect(
      new URL(`${next}${joiner(next)}signin=failed`, url.origin),
    );
  }

  // The bag comes with them. A failure here must not cost them the sign-in they
  // just completed — the guest token is left in place so the bag stays
  // reachable and the next sign-in picks it up again.
  let merged = 0;
  try {
    const guestToken = await readGuestToken();
    const outcome = await mergeGuestCartIntoAccount(
      supabase,
      data.session.user.id,
      guestToken,
    );
    merged = outcome.merged;
    if (outcome.dropped > 0) {
      console.warn(
        `[cart] merge dropped ${outcome.dropped} line(s) that were no longer sellable`,
      );
    }

    // Whatever they bought as a guest is theirs now. Its own try, because an
    // order is worth more than a bag: a failure here must not be swallowed by
    // the merge's handler, and it must veto the cookie deletion below.
    let adopted = false;
    try {
      const count = await adoptGuestOrders(supabase, guestToken);
      adopted = true;
      if (count > 0)
        console.info(
          `[orders] attached ${count} guest order(s) to the account`,
        );
    } catch (adoptError) {
      console.error(
        "[orders] adopting guest orders on sign-in failed:",
        adoptError,
      );
    }

    // Only once the guest bag is gone *and* the orders have somewhere else to
    // be reached from. Dropping the cookie while either still needs it strands
    // it — nothing can ever address it again.
    if (outcome.guestCartConsumed && adopted) await clearGuestToken();
  } catch (mergeError) {
    console.error("[cart] merge on sign-in failed:", mergeError);
  }

  // Finish what they were doing when they were interrupted. Read-and-forget, so
  // a failure here leaves somebody signed in who can press the heart again
  // rather than a cookie that retries forever.
  try {
    const intent = await takePendingIntent();
    if (intent?.kind === "save") {
      const saved = await saveProduct(intent.productId);
      if (!saved) console.warn("[auth] pending save did not complete");
    }
  } catch (intentError) {
    console.error("[auth] pending intent failed:", intentError);
  }

  return finish(url, next, merged);
}

/** The redirect, in one place, so an early return cannot forget the count. */
function finish(url: URL, next: string, merged: number): NextResponse {
  const destination = new URL(next, url.origin);
  // Told, not silently done: something arrived in their bag during a redirect
  // they did not ask for, and the cart page says so on arrival.
  if (merged > 0) destination.searchParams.set("merged", String(merged));
  return NextResponse.redirect(destination);
}

/** `?` or `&`, depending on whether the destination already carries a query. */
function joiner(path: string): string {
  return path.includes("?") ? "&" : "?";
}
