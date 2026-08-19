import "server-only";

import { deployedCommit } from "@/lib/deploy/version";
import { razorpayModeHealth, type ModeCheck, type WebhookHealth } from "@/lib/payments/health";
import { readWebhookLiveness } from "@/lib/queries/admin/dashboard";
import { maybeRow, rows } from "@/lib/queries/run";
import { shiprocketWalletStatus, type WalletStatus } from "@/lib/shipping/wallet";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Everything about the shop that fails silently, on one screen (§Batch D).
 *
 * The dashboard answers "what needs doing"; this page answers "is the
 * machinery alive". Every section degrades to an honest "could not read"
 * rather than a guess, for the same reason the wallet does — a health page
 * that renders a wrong "fine" teaches the owner to stop opening it.
 *
 * ## The stuck-order thresholds
 *
 * Operational judgment calls, not business numbers — nothing here changes
 * what a customer is charged:
 *
 * - **Captured, not confirmed — 15 minutes.** The webhook grace is ten;
 *   an order still `pending` with captured money past that is the exact
 *   shape of FV-2026-00623 and it is holding the customer's money.
 * - **Confirmed, not packed — 48 hours.** The shop hands parcels to the
 *   courier daily; two days of silence on a paid order is a forgotten one.
 * - **Shipped, not tracking — 72 hours.** A parcel can be handed over
 *   before the AWB lands, but three days with no tracking number, or a
 *   tracker that has not been checked in three days, is a parcel nobody
 *   can answer questions about.
 */
export const STUCK_THRESHOLDS = {
  capturedNotConfirmedMs: 15 * 60_000,
  confirmedNotPackedMs: 48 * 3_600_000,
  shippedNotTrackingMs: 72 * 3_600_000,
} as const;

export type StuckOrder = {
  id: string;
  orderNumber: string;
  status: string;
  placedAt: string;
  grandTotal: number;
  /** What makes it stuck, phrased for the row. */
  detail: string;
};

export type CronJobHealth = {
  jobname: string;
  schedule: string;
  active: boolean;
  lastStatus: string | null;
  lastStarted: string | null;
  lastFinished: string | null;
  lastMessage: string | null;
};

export type ShiprocketAuthHealth =
  | { state: "held"; expiresAt: string }
  | { state: "expired"; expiresAt: string }
  | { state: "none" }
  | { state: "locked_out"; reason: string; until: string }
  | { state: "unreadable"; message: string };

export type DriftHealth =
  | { state: "clean"; variantsChecked: number }
  | {
      state: "drifted";
      variantsChecked: number;
      rows: { sku: string; stock: number; ledger: number; drift: number }[];
    }
  | { state: "unreadable"; message: string };

/**
 * Whether the build that is answering this request is the one at the tip of the
 * production branch.
 *
 * **This is the check that did not exist on 2026-08-20**, when Vercel refused
 * four deployments in a row before any build started, `main` moved three
 * commits ahead, every CI job stayed green, and the shop quietly went on
 * serving a build from six days earlier. Nothing in the panel, the gates or CI
 * could see it. A person noticed the colour behind a photograph.
 *
 * `unknown` is deliberately not a fourth flavour of `clean`. Determining the
 * *expected* side means asking GitHub for the tip of `main`. The repository is
 * **public** — this check shipped on 2026-08-20 believing it private and
 * demanding `GITHUB_REPO_TOKEN`, which would have left the card saying
 * "unverified" until somebody minted a token for a fact anyone can already
 * read. So the call is made either way; a token, when present, only buys
 * rate-limit headroom (5,000/hr against 60/hr per egress IP). When GitHub
 * cannot be read the card says so, in a tone that is not green: the page's
 * standing rule is that a wrong "fine" teaches the owner to stop opening the
 * page, and there is no version of this check worth having that can be
 * satisfied by not looking.
 */
export type DeploymentHealth =
  | {
      state: "in_sync";
      deployed: string;
      ref: string | null;
      environment: string | null;
    }
  | {
      state: "drifted";
      deployed: string;
      expected: string;
      ref: string | null;
      environment: string | null;
    }
  | {
      /** The build knows its commit; nothing could be learned about the branch. */
      state: "expected_unknown";
      deployed: string;
      ref: string | null;
      environment: string | null;
      reason: string;
    }
  | { state: "unknown"; reason: string };

export type HealthSnapshot = {
  keyMode: ModeCheck;
  webhook: WebhookHealth;
  wallet: WalletStatus;
  shiprocketAuth: ShiprocketAuthHealth;
  stuck: {
    capturedNotConfirmed: StuckOrder[];
    confirmedNotPacked: StuckOrder[];
    shippedNotTracking: StuckOrder[];
    unreadable: string | null;
  };
  drift: DriftHealth;
  /** Named for the deployment, not the stock ledger — `drift` above is that. */
  deployment: DeploymentHealth;
  cron: { jobs: CronJobHealth[]; unreadable: string | null };
  /**
   * What the delivery poller is watching: shipped orders with an AWB and no
   * delivery or RTO stamp yet. Zero is the healthy idle state; a number that
   * only ever grows means parcels are moving without ever arriving, which is
   * either a courier problem or the poller not running — the `poll-deliveries`
   * row in the cron table above says which.
   */
  parcelsInFlight: number | null;
};

export async function getHealth(): Promise<HealthSnapshot> {
  const supabase = await createClient();

  const [
    webhook,
    wallet,
    shiprocketAuth,
    stuck,
    drift,
    deployment,
    cron,
    parcelsInFlight,
  ] = await Promise.all([
    readWebhookLiveness(supabase),
    shiprocketWalletStatus(),
    readShiprocketAuth(),
    readStuckOrders(supabase),
    readDrift(),
    readDeployment(),
    readCron(),
    readParcelsInFlight(supabase),
  ]);

  return {
    keyMode: razorpayModeHealth(),
    webhook,
    wallet,
    shiprocketAuth,
    stuck,
    drift,
    deployment,
    cron,
    parcelsInFlight,
  };
}

/**
 * The deployed commit, and the tip of the branch it claims to be built from.
 *
 * The deployed side is free — Vercel bakes it into the bundle at build time, so
 * a stale build reports its own staleness rather than something newer.
 *
 * The expected side costs a network call to GitHub. The repository is public,
 * so the call needs no credential; `GITHUB_REPO_TOKEN`, when set, is attached
 * for rate-limit headroom only. When GitHub cannot be read this returns
 * `expected_unknown` and the page says so; it does **not** fall back to
 * reporting the deployed commit as correct, because a check that passes when it
 * cannot see is worse than no check — it is a check that lies.
 *
 * Failures here are caught and reported rather than thrown: this is one card on
 * a page whose whole job is to be openable when things are broken, and taking
 * the page down to report that GitHub is slow would be the wrong trade.
 */
async function readDeployment(): Promise<DeploymentHealth> {
  const commit = deployedCommit();
  if (commit.state === "unknown") {
    return { state: "unknown", reason: commit.reason };
  }

  const token = process.env.GITHUB_REPO_TOKEN;
  const owner = process.env.VERCEL_GIT_REPO_OWNER;
  const repo = process.env.VERCEL_GIT_REPO_SLUG;
  const branch = commit.ref ?? "main";

  const base = {
    deployed: commit.sha,
    ref: commit.ref,
    environment: commit.environment,
  };

  if (!owner || !repo) {
    return {
      state: "expected_unknown",
      ...base,
      reason:
        "VERCEL_GIT_REPO_OWNER / VERCEL_GIT_REPO_SLUG are not set on this build.",
    };
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`,
      {
        headers: {
          // The repo is public; the token is optional headroom, not access.
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          Accept: "application/vnd.github+json",
          "User-Agent": "footvault-health",
        },
        // Never cached. The whole question is "what is true right now", and a
        // cached answer is how this reports the previous tip and passes.
        cache: "no-store",
        signal: AbortSignal.timeout(6_000),
      },
    );
    if (!response.ok) {
      return {
        state: "expected_unknown",
        ...base,
        reason:
          `GitHub answered ${response.status} for ${owner}/${repo}@${branch}.` +
          (response.status === 403 && !token
            ? " Likely the unauthenticated rate limit (60/hr per IP, shared on Vercel) — a GITHUB_REPO_TOKEN raises it to 5,000/hr."
            : ""),
      };
    }
    const body: unknown = await response.json();
    const expected =
      typeof body === "object" && body !== null && "sha" in body
        ? String((body as { sha: unknown }).sha).toLowerCase()
        : "";
    if (!/^[0-9a-f]{40}$/.test(expected)) {
      return {
        state: "expected_unknown",
        ...base,
        reason: "GitHub did not return a commit SHA for that branch.",
      };
    }
    return expected === commit.sha
      ? { state: "in_sync", ...base }
      : { state: "drifted", ...base, expected };
  } catch (error) {
    return {
      state: "expected_unknown",
      ...base,
      reason:
        error instanceof Error
          ? `Could not reach GitHub: ${error.message}`
          : "Could not reach GitHub.",
    };
  }
}

/** The same filter the poller's selector uses; null when unreadable. */
async function readParcelsInFlight(supabase: Supabase): Promise<number | null> {
  const { count, error } = await supabase
    .from("orders")
    .select("id, shipments!inner(awb_code)", { count: "exact", head: true })
    .eq("status", "shipped")
    .is("delivered_at", null)
    .is("rto_at", null)
    .not("shipments.awb_code", "is", null);
  if (error) {
    console.error("[health] parcels in flight unreadable:", error.message);
    return null;
  }
  return count;
}

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * Whether a Shiprocket call made right now would have a token to ride on.
 *
 * "None" is not an error: the client logs in lazily, so an idle shop holds no
 * token. What the owner needs called out is the *lockout* row — the latch the
 * token module sets after repeated auth failures, during which every
 * fulfilment call fails fast — because that one means somebody changed the
 * password and the shop cannot ship.
 *
 * Through the admin client, not the RLS one: `integration_tokens` grants
 * nothing to any browser role on purpose (it holds a bearer token), and this
 * page sits behind the double admin lock. Found by this very page rendering
 * its own 42501 on first light.
 */
async function readShiprocketAuth(): Promise<ShiprocketAuthHealth> {
  try {
    const supabase = createAdminClient();
    const [token, lockout] = await Promise.all([
      maybeRow<{ expires_at: string }>(
        "admin.health.shiprocketToken",
        supabase
          .from("integration_tokens")
          .select("expires_at")
          .eq("provider", "shiprocket")
          .maybeSingle(),
      ),
      maybeRow<{ token: string; expires_at: string }>(
        "admin.health.shiprocketLockout",
        supabase
          .from("integration_tokens")
          .select("token, expires_at")
          .eq("provider", "shiprocket:auth_lockout")
          .maybeSingle(),
      ),
    ]);

    if (lockout && Date.parse(lockout.expires_at) > Date.now()) {
      return {
        state: "locked_out",
        reason: lockout.token,
        until: lockout.expires_at,
      };
    }
    if (!token) return { state: "none" };
    return Date.parse(token.expires_at) > Date.now()
      ? { state: "held", expiresAt: token.expires_at }
      : { state: "expired", expiresAt: token.expires_at };
  } catch (error) {
    return {
      state: "unreadable",
      message:
        error instanceof Error ? error.message : "could not read the tokens",
    };
  }
}

async function readStuckOrders(
  supabase: Supabase,
): Promise<HealthSnapshot["stuck"]> {
  const now = Date.now();
  try {
    const [pendingPaid, confirmedOld, shippedRows] = await Promise.all([
      /**
       * Money captured, order still pending. Joined through `payments` rather
       * than `payment_status`, because the failure being hunted is exactly the
       * one where the capture never applied to the order.
       */
      rows<{
        order_id: string;
        created_at: string;
        order: {
          id: string;
          order_number: string;
          status: string;
          placed_at: string;
          grand_total: number;
        } | null;
      }>(
        "admin.health.capturedNotConfirmed",
        supabase
          .from("payments")
          .select(
            "order_id, created_at, order:orders!inner ( id, order_number, status, placed_at, grand_total )",
          )
          .eq("status", "captured")
          .eq("order.status", "pending")
          .overrideTypes<
            {
              order_id: string;
              created_at: string;
              order: {
                id: string;
                order_number: string;
                status: string;
                placed_at: string;
                grand_total: number;
              } | null;
            }[]
          >(),
      ),
      rows<{
        id: string;
        order_number: string;
        status: string;
        placed_at: string;
        grand_total: number;
        updated_at: string;
      }>(
        "admin.health.confirmedNotPacked",
        supabase
          .from("orders")
          .select("id, order_number, status, placed_at, grand_total, updated_at")
          .eq("status", "confirmed")
          .lt(
            "updated_at",
            new Date(now - STUCK_THRESHOLDS.confirmedNotPackedMs).toISOString(),
          ),
      ),
      rows<{
        id: string;
        order_number: string;
        status: string;
        placed_at: string;
        grand_total: number;
        shipments: { awb_code: string | null; tracked_at: string | null }[];
      }>(
        "admin.health.shippedNotTracking",
        supabase
          .from("orders")
          .select(
            "id, order_number, status, placed_at, grand_total, shipments ( awb_code, tracked_at )",
          )
          .eq("status", "shipped")
          .overrideTypes<
            {
              id: string;
              order_number: string;
              status: string;
              placed_at: string;
              grand_total: number;
              shipments: { awb_code: string | null; tracked_at: string | null }[];
            }[]
          >(),
      ),
    ]);

    const capturedNotConfirmed: StuckOrder[] = pendingPaid
      .filter(
        (row) =>
          row.order &&
          now - Date.parse(row.created_at) >
            STUCK_THRESHOLDS.capturedNotConfirmedMs,
      )
      .map((row) => ({
        id: row.order!.id,
        orderNumber: row.order!.order_number,
        status: row.order!.status,
        placedAt: row.order!.placed_at,
        grandTotal: row.order!.grand_total,
        detail: "money captured, order still pending — the customer has paid",
      }));

    const confirmedNotPacked: StuckOrder[] = confirmedOld.map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      status: row.status,
      placedAt: row.placed_at,
      grandTotal: row.grand_total,
      detail: `confirmed and untouched since ${row.updated_at.slice(0, 10)}`,
    }));

    const shippedNotTracking: StuckOrder[] = shippedRows
      .filter((row) => {
        const shipment = row.shipments[0];
        if (!shipment) return true;
        if (!shipment.awb_code) return true;
        if (!shipment.tracked_at) return false; // AWB assigned, tracker simply not polled yet
        return (
          now - Date.parse(shipment.tracked_at) >
          STUCK_THRESHOLDS.shippedNotTrackingMs
        );
      })
      .map((row) => ({
        id: row.id,
        orderNumber: row.order_number,
        status: row.status,
        placedAt: row.placed_at,
        grandTotal: row.grand_total,
        detail: row.shipments[0]?.awb_code
          ? "tracking has not been checked in three days"
          : "shipped with no tracking number",
      }));

    return {
      capturedNotConfirmed,
      confirmedNotPacked,
      shippedNotTracking,
      unreadable: null,
    };
  } catch (error) {
    return {
      capturedNotConfirmed: [],
      confirmedNotPacked: [],
      shippedNotTracking: [],
      unreadable:
        error instanceof Error ? error.message : "could not read the orders",
    };
  }
}

/**
 * `reconcile_inventory()` compares every variant's shelf figure with the sum
 * of its movement ledger. Service-role only, so this read goes through the
 * admin client — the page itself is already double-locked behind `is_admin`.
 */
async function readDrift(): Promise<DriftHealth> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("reconcile_inventory");
    if (error) return { state: "unreadable", message: error.message };
    const all = data ?? [];
    const drifted = all.filter((row) => row.drift !== 0);
    if (drifted.length === 0)
      return { state: "clean", variantsChecked: all.length };
    return {
      state: "drifted",
      variantsChecked: all.length,
      rows: drifted.map((row) => ({
        sku: row.sku,
        stock: row.stock_quantity,
        ledger: Number(row.ledger_total),
        drift: Number(row.drift),
      })),
    };
  } catch (error) {
    return {
      state: "unreadable",
      message:
        error instanceof Error ? error.message : "could not run the reconcile",
    };
  }
}

async function readCron(): Promise<HealthSnapshot["cron"]> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("cron_health");
    if (error) return { jobs: [], unreadable: error.message };
    return {
      jobs: (data ?? []).map((row) => ({
        jobname: row.jobname,
        schedule: row.schedule,
        active: row.active,
        lastStatus: row.last_status,
        lastStarted: row.last_started,
        lastFinished: row.last_finished,
        lastMessage: row.last_message,
      })),
      unreadable: null,
    };
  } catch (error) {
    return {
      jobs: [],
      unreadable:
        error instanceof Error ? error.message : "could not read the schedule",
    };
  }
}
