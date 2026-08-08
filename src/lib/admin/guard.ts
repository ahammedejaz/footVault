import "server-only";

import { cache } from "react";

import { getCurrentUser } from "@/lib/auth";
import { consumeRateLimit, type RateLimitPolicy } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * The admin authorization boundary. Everything in /admin passes through here.
 *
 * **The 404 in `src/lib/supabase/proxy.ts` is not authorization.** It protects
 * *navigation*: it decides what happens when a browser asks for an /admin URL.
 * It has nothing to say about a Server Action, which is a POST to a route the
 * middleware matcher does not distinguish from any other, carrying an action id
 * that is sitting in the JavaScript bundle any signed-in customer can read. An
 * admin panel whose only guard is middleware is an admin panel with no guard.
 *
 * So every mutation checks again, here, server-side, before doing anything —
 * and it does so by asking the *database*, not by trusting a claim. `is_admin()`
 * is SECURITY DEFINER and reads `profiles.role` for `auth.uid()`, so the answer
 * cannot be influenced by anything the caller sends. A `role` claim inside a JWT
 * would be the wrong thing to read even though it would be faster.
 *
 * `adminAction` exists so that checking is the path of least resistance rather
 * than a thing to remember, and `eslint-rules/admin-actions-must-guard.mjs`
 * fails the build on any exported action under `src/lib/actions/admin/` that
 * does not go through it.
 */

export type AdminActor = {
  id: string;
  email: string | null;
  name: string | null;
};

/**
 * The actor if they are an admin, null otherwise.
 *
 * Wrapped in React's `cache` so a page that renders eight admin components
 * verifies once per request rather than eight times. The cache is per-request
 * by construction — `cache()` is scoped to a single React render — so it can
 * never hand one request's verdict to another.
 */
export const currentAdmin = cache(async (): Promise<AdminActor | null> => {
  const user = await getCurrentUser();
  if (!user) return null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("is_admin");
  if (error) {
    // Fail closed, loudly. An unreachable database must never open the panel,
    // and this is the one place in the codebase where a swallowed error would
    // be an authorization bypass rather than a blank page.
    console.error("[admin] is_admin() failed, denying:", error.message);
    return null;
  }
  if (data !== true) return null;

  return { id: user.id, email: user.email, name: user.name };
});

/** For pages and layouts: the actor, or null for the caller to 404 on. */
export async function adminActorOrNull(): Promise<AdminActor | null> {
  return currentAdmin();
}

export type AdminFailure =
  | { ok: false; reason: "forbidden"; message: string }
  | {
      ok: false;
      reason: "throttled";
      message: string;
      retryAfterSeconds: number;
    }
  | { ok: false; reason: "invalid"; message: string; field?: string }
  | { ok: false; reason: "conflict"; message: string }
  | { ok: false; reason: "error"; message: string };

export type AdminResult<T> = ({ ok: true } & T) | AdminFailure;

/**
 * What every admin mutation is wrapped in.
 *
 * Four things happen before the caller's work runs, in this order and for these
 * reasons:
 *
 *   1. **`is_admin()`, against the database.** The whole point. A signed-in
 *      customer who found the action id in the bundle stops here.
 *   2. **Rate limiting, keyed to the admin.** After the authorization check, so
 *      an unauthorised caller cannot spend a real admin's allowance by
 *      hammering the action — which is what keying it by IP would have allowed.
 *   3. **Two clients, and the safe one is the default.** `supabase` is the
 *      *caller's own* client, where the `admins manage …` RLS policies apply and
 *      the database re-checks `is_admin()` on every single row. Almost all admin
 *      work goes through it, which means the panel's authorization does not
 *      depend on this file being correct — a bug here still hits a closed door
 *      in Postgres. `elevated` is the service-role client, and it is only for
 *      what RLS genuinely cannot express: reading `auth.users` for a customer's
 *      email, which lives outside `public` entirely. Every use of it is a
 *      decision to leave the safety net, so it is named to look like one.
 *   4. **A catch.** An unhandled throw in a Server Action reaches the client as
 *      an opaque digest, which for an owner in a shop is indistinguishable from
 *      the button not working.
 *
 * The failure shapes are deliberately vague to the caller and specific to the
 * log. `forbidden` says "not available" rather than "you are not an admin",
 * because a customer probing actions learns nothing from the first and quite a
 * lot from the second.
 */
export async function adminAction<T extends object>(
  label: string,
  policy: RateLimitPolicy,
  work: (context: {
    actor: AdminActor;
    /** The caller's own client. RLS applies; admin policies let it through. */
    supabase: Awaited<ReturnType<typeof createClient>>;
    /** Service role. Bypasses RLS. Only where RLS cannot express the rule. */
    elevated: () => ReturnType<typeof createAdminClient>;
  }) => Promise<AdminResult<T>>,
): Promise<AdminResult<T>> {
  const actor = await currentAdmin();
  if (!actor) {
    console.warn(`[admin] ${label} refused: caller is not an admin`);
    return {
      ok: false,
      reason: "forbidden",
      message: "That is not available.",
    };
  }

  const throttle = await consumeRateLimit(policy, `admin:${actor.id}`);
  if (!throttle.allowed) {
    return {
      ok: false,
      reason: "throttled",
      retryAfterSeconds: throttle.retryAfterSeconds,
      message: `Too many changes at once. Try again in ${throttle.retryAfterSeconds}s.`,
    };
  }

  try {
    return await work({
      actor,
      supabase: await createClient(),
      elevated: createAdminClient,
    });
  } catch (thrown) {
    console.error(`[admin] ${label} threw:`, thrown);
    return {
      ok: false,
      reason: "error",
      message:
        "That did not save. Nothing has been changed — please try again.",
    };
  }
}

/**
 * Attribution for `record_inventory_movement()`, set on the connection that is
 * about to move stock.
 *
 * Every stock write from the admin panel goes through this, because a movement
 * row whose actor is null is a movement nobody can be asked about — and the
 * entire reason this phase built a ledger before it built a stock editor is
 * that the shop owner is now allowed to change a number by hand.
 *
 * The GUCs are transaction-local (`is_local = true`), so they cannot survive
 * into another request over a pooled connection. That means they must be set
 * *inside* the same transaction as the write, which is why this is only ever
 * called from inside a database function rather than as a separate round trip
 * from here. `adjust_variant_stock()` is that function.
 */
export const INVENTORY_NOTE_MAX = 240;
