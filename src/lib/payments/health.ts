import "server-only";

import { razorpayKeyId } from "@/lib/payments/config";

/**
 * The two things about the payment chain that are silent when they are wrong.
 *
 * Both were found the same way: by looking, not by being told. Stage 1 ran
 * `GET /v1/webhooks` against the live keys and got `{"count":0}` — no live
 * webhook had ever been created, so every Razorpay-paid order was being
 * confirmed by the browser callback alone and nothing anywhere said so. The
 * shop looked fine. It was fine, right up until a customer closed the tab.
 *
 * A wrong `RAZORPAY_KEY_ID` fails the same way round: test keys in production
 * take fake money and confirm real orders, and nothing throws. Live keys in
 * development take *real* money from whoever is testing.
 *
 * So: two assertions, both rendered on the admin dashboard, both defined so
 * that a quiet shop cannot make them cry wolf.
 */

/* ------------------------------------------------------------ key mode -- */

export type RazorpayMode = "live" | "test" | "unknown";
export type DeployEnv = "production" | "preview" | "development";

export type ModeCheck =
  | { ok: true; mode: RazorpayMode; env: DeployEnv }
  | {
      ok: false;
      mode: RazorpayMode;
      env: DeployEnv;
      expected: RazorpayMode;
      message: string;
    };

/** `rzp_live_…` / `rzp_test_…`. Anything else is a key we cannot vouch for. */
export function razorpayMode(keyId: string | null): RazorpayMode {
  if (!keyId) return "unknown";
  if (keyId.startsWith("rzp_live_")) return "live";
  if (keyId.startsWith("rzp_test_")) return "test";
  return "unknown";
}

/** Live money on production, nowhere else. */
export function expectedMode(env: DeployEnv): RazorpayMode {
  return env === "production" ? "live" : "test";
}

/**
 * Pure, so all four key/environment combinations are testable without touching
 * `process.env` — which is the only way to test the combination that matters
 * (test keys on production) without being on production.
 */
export function checkKeyMode(keyId: string | null, env: DeployEnv): ModeCheck {
  const mode = razorpayMode(keyId);
  const expected = expectedMode(env);
  if (mode === expected) return { ok: true, mode, env };
  return {
    ok: false,
    mode,
    env,
    expected,
    message: mismatchMessage(keyId, mode, env, expected),
  };
}

function mismatchMessage(
  keyId: string | null,
  mode: RazorpayMode,
  env: DeployEnv,
  expected: RazorpayMode,
): string {
  const wanted = expected === "live" ? "rzp_live_" : "rzp_test_";
  const where =
    env === "production"
      ? "the Vercel project's Production environment"
      : env === "preview"
        ? "the Vercel project's Preview environment"
        : ".env.local";

  if (keyId === null) {
    return `RAZORPAY_KEY_ID is not set. Razorpay cannot take a payment at all. Set a ${wanted} key in ${where}.`;
  }
  if (mode === "unknown") {
    return `RAZORPAY_KEY_ID is neither rzp_live_ nor rzp_test_, so we cannot tell which mode this deployment is in. Set a ${wanted} key in ${where}.`;
  }
  if (mode === "live") {
    return `RAZORPAY_KEY_ID is a LIVE key on a ${env} deployment. Every test payment made here charges a real card. Set a ${wanted} key in ${where}.`;
  }
  return `RAZORPAY_KEY_ID is a TEST key on the ${env} deployment. Customers are being handed a test checkout, so no money is arriving and their orders confirm anyway. Set a ${wanted} key in ${where} and redeploy.`;
}

/**
 * Which deployment this is.
 *
 * `NODE_ENV` is not usable for this and the reason is the whole point:
 * `next build` sets `NODE_ENV=production` for preview builds too, so a check
 * written against it passes on preview no matter which key is loaded — the
 * exact hole it was meant to close. `VERCEL_ENV` is the only variable that
 * distinguishes the three, and its absence means nobody deployed this: a
 * developer is running it on their own machine.
 */
export function deploymentEnv(): DeployEnv {
  const value = process.env.VERCEL_ENV;
  if (
    value === "production" ||
    value === "preview" ||
    value === "development"
  ) {
    return value;
  }
  return "development";
}

/** Logged once per process, not once per render — the dashboard is uncached. */
let mismatchLogged = false;

export function razorpayModeHealth(): ModeCheck {
  const check = checkKeyMode(razorpayKeyId(), deploymentEnv());
  if (!check.ok && !mismatchLogged) {
    mismatchLogged = true;
    console.error(
      "[payments] Razorpay key mode does not match the deployment",
      {
        env: check.env,
        mode: check.mode,
        expected: check.expected,
        detail: check.message,
      },
    );
  }
  return check;
}

/* ------------------------------------------------------ webhook liveness -- */

/**
 * The row type that must never be counted as a webhook.
 *
 * `payment_events` holds two different things. The webhook route writes
 * `payment.captured` and friends; `verifyRazorpayPayment` writes
 * `client.callback` from the customer's browser, and it writes one for every
 * paid order. Count those and a completely dead webhook chain reads as healthy,
 * because the browser is still reporting in — which is precisely the failure
 * this check exists to find. Exported so the query and its test share one
 * string rather than two that can drift.
 */
export const CLIENT_CALLBACK_EVENT_TYPE = "client.callback";

export type WebhookLiveness =
  | { state: "ok"; lastEventAt: string }
  | { state: "never"; lastPaidOrderAt: string | null }
  | { state: "behind"; lastEventAt: string | null; lastPaidOrderAt: string }
  | { state: "idle" };

/** What the dashboard renders: the verdict, or an honest "we could not read it". */
export type WebhookHealth =
  WebhookLiveness | { state: "unknown"; message: string };

/**
 * How long a paid order may sit without its webhook before we call it broken.
 *
 * Razorpay usually delivers in seconds, but the browser callback confirms the
 * order first, so without a window here the dashboard would flash "the webhook
 * chain is not delivering" for the few seconds between the two — on every
 * single payment, to an owner who is watching the screen precisely because a
 * payment just came in. An alarm that is wrong that often is one the owner
 * learns to ignore, and then it is worse than nothing.
 *
 * Ten minutes covers Razorpay's first retry. A chain that is genuinely dead
 * still turns red on the next refresh after that.
 */
export const WEBHOOK_GRACE_MS = 10 * 60_000;

/**
 * An unreadable timestamp is treated as no timestamp. Comparing against `NaN`
 * is false in both directions, which would silently report "ok" forever.
 */
function stamp(iso: string | null): { iso: string; ms: number } | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : { iso, ms };
}

/**
 * Judged against the last paid order, never against the clock.
 *
 * A shop that sold nothing for three days has a perfectly healthy webhook and
 * no webhooks — wall-clock staleness would paint that red every quiet week,
 * and the owner would stop reading it. The only thing that is evidence of a
 * broken chain is money that arrived with no server-to-server event behind it.
 *
 * Pure, and `now` is injectable, so every state is testable without a database
 * and without waiting.
 */
export function judgeWebhookLiveness(input: {
  /** `max(received_at)` over `payment_events` **excluding** client callbacks. */
  lastServerEventAt: string | null;
  /** `max(placed_at)` over orders whose online money arrived. */
  lastPaidOrderAt: string | null;
  now?: Date;
  graceMs?: number;
}): WebhookLiveness {
  const now = (input.now ?? new Date()).getTime();
  const graceMs = input.graceMs ?? WEBHOOK_GRACE_MS;

  const event = stamp(input.lastServerEventAt);
  const paid = stamp(input.lastPaidOrderAt);

  // No online money has ever arrived, so there is nothing to be behind on. A
  // webhook that fired anyway — a failed payment, say — is still worth showing,
  // because it proves the chain is wired, and that beats a bare "idle".
  if (paid === null) {
    return event === null
      ? { state: "idle" }
      : { state: "ok", lastEventAt: event.iso };
  }

  // Money arrived and Razorpay has never once talked to us server-to-server.
  // This is the shape of the bug Phase 8 opened on, and no grace applies: there
  // is no working chain here to give the benefit of the doubt to.
  if (event === null) {
    return { state: "never", lastPaidOrderAt: paid.iso };
  }

  if (paid.ms > event.ms) {
    if (now - paid.ms < graceMs) return { state: "ok", lastEventAt: event.iso };
    return {
      state: "behind",
      lastEventAt: event.iso,
      lastPaidOrderAt: paid.iso,
    };
  }

  return { state: "ok", lastEventAt: event.iso };
}

/* ---------------------------------------------------------- presentation -- */

/**
 * Re-exported so the many callers that already say
 * `import { relativeAge } from "@/lib/payments/health"` keep working. The
 * implementation moved to `@/lib/format` when a Client Component needed it —
 * this module is `server-only`, and a value import of it from the browser is a
 * build error.
 */
export { relativeAge } from "@/lib/format";

