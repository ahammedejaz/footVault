import "server-only";

import type { Database } from "@/lib/database.types";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The idempotency ledger: one row per provider event, ever.
 *
 * Razorpay retries. Not "might" — a webhook that answers slowly, or with
 * anything other than a 2xx, is redelivered, and the same `payment.captured`
 * will arrive two, three, five times. Every one of those must be a no-op after
 * the first, and "no-op" has to be enforced by the database rather than by the
 * handler noticing, because two retries can be in flight at the same instant
 * and both will read the same "not handled yet".
 *
 * So the claim is an `insert`, and the guard is
 * `payment_events_unique_per_provider unique (provider, event_id)`. Two
 * concurrent deliveries both insert; exactly one gets a row and the other gets
 * `23505` and stops. That is the only race-free version of this, and it is why
 * the check is not a `select` first.
 *
 * ## Who writes what
 *
 * This module writes **only** the claim — `provider`, `event_id`, `event_type`
 * — and deletes it again if the work did not finish. The rest of the row
 * (`order_id`, `processed_at`, `result`) is filled in by `applyPaymentOutcome`
 * in `src/lib/orders/`, which is the half that knows which order the event
 * touched and what it decided. Both halves of that split are deliberate: the
 * claim has to happen before anything looks at an order, and only the order
 * code may write order facts.
 *
 * Service role, not the request client: a webhook has no session, RLS has no
 * `auth.uid()` to work with, and `payment_events` grants nothing to `anon` or
 * `authenticated` beyond an admin read. The caller has already been
 * authenticated by something far stronger than a cookie — an HMAC over the
 * request body.
 */

type PaymentProvider = Database["public"]["Enums"]["payment_provider"];

/** Postgres unique violation. The whole mechanism rests on this one code. */
const UNIQUE_VIOLATION = "23505";

/**
 * PostgREST cannot see a table that does not exist and says so with `PGRST205`
 * rather than Postgres' own `42P01`. Both are named because the difference
 * between "the migration has not been applied to this environment" and
 * "something is badly wrong" is worth reading off the log line rather than
 * guessing at.
 */
const MISSING_TABLE = new Set(["PGRST205", "42P01"]);

export type EventClaim =
  | { claimed: true }
  /** Someone already has this event. Not an error — the expected steady state. */
  | { claimed: false; reason: "duplicate" };

/**
 * Take ownership of one event, or discover that it is already taken.
 *
 * Throws on anything that is not a duplicate. That is deliberate: an unclaimed
 * event whose ledger write failed must not be processed, because there is then
 * nothing stopping the retry from processing it again. The caller turns the
 * throw into a 500 and Razorpay redelivers, which is exactly what should
 * happen when our database is unreachable.
 */
export async function claimPaymentEvent(
  provider: PaymentProvider,
  eventId: string,
  eventType: string,
): Promise<EventClaim> {
  const supabase = createAdminClient();

  const { error } = await supabase.from("payment_events").insert({
    provider,
    event_id: eventId,
    event_type: eventType,
  });

  if (!error) return { claimed: true };

  if (error.code === UNIQUE_VIOLATION) return { claimed: false, reason: "duplicate" };

  if (MISSING_TABLE.has(error.code ?? "")) {
    throw new Error(
      "claimPaymentEvent: public.payment_events is not present in this environment. " +
        "Payment webhooks cannot be made idempotent without it, so they are being refused " +
        `rather than applied unguarded. Apply the migrations. [${error.code}]`,
    );
  }

  throw new Error(`claimPaymentEvent(${provider}:${eventId}): ${error.message} [${error.code}]`);
}

/**
 * Give the claim back, so a redelivery can try again.
 *
 * Without this, one transient database error while applying an outcome would
 * leave the event permanently marked handled: the retry arrives, sees the
 * claim, returns 200, and a captured payment silently never confirms its order.
 * That failure has no error anywhere — it is the worst shape a bug can take in
 * this codebase — so the claim is released on every path that did not finish.
 *
 * Deletes only rows this module could have written: `processed_at is null`
 * means `applyPaymentOutcome` never finished with it. If the order code has
 * already stamped the row, the work *did* happen and the claim is not ours to
 * take back, however the caller ended up here.
 *
 * Never throws. It is called from a `catch`, and an exception here would
 * replace the real error with this one.
 */
export async function releasePaymentEvent(
  provider: PaymentProvider,
  eventId: string,
): Promise<void> {
  try {
    const supabase = createAdminClient();

    const { error } = await supabase
      .from("payment_events")
      .delete()
      .eq("provider", provider)
      .eq("event_id", eventId)
      .is("processed_at", null);

    if (error) {
      console.error("[payments] could not release an event claim; it may need clearing by hand", {
        provider,
        eventId,
        code: error.code,
      });
    }
  } catch (thrown) {
    console.error("[payments] releasing an event claim threw", {
      provider,
      eventId,
      detail: thrown instanceof Error ? thrown.message : "unknown",
    });
  }
}
