import type { Metadata } from "next";
import Link from "next/link";

import { Table, TableWrap, Td, Th } from "@/components/admin/table";
import { AdminPage, Chip, PageHeader } from "@/components/admin/ui";
import { formatPaise } from "@/lib/format";
import { relativeAge } from "@/lib/payments/health";
import { getHealth, type HealthSnapshot, type StuckOrder } from "@/lib/queries/admin/health";
import {
  checkPickupConfiguration,
  type PickupVerdict,
} from "@/lib/shipping/pickup";

export const metadata: Metadata = { title: "Health" };
export const dynamic = "force-dynamic";

/**
 * Is the machinery alive. Every section here is a thing that fails silently —
 * a webhook chain that stopped, a cron job that quietly died, a parcel nobody
 * is tracking — and the page's one rule is that it never renders a guess:
 * "could not read" is its own state, loudly, because a wrong "fine" teaches
 * the owner to stop opening the page.
 */
export default async function AdminHealthPage() {
  const [health, pickup] = await Promise.all([
    getHealth(),
    checkPickupConfiguration(),
  ]);

  const stuckCount =
    health.stuck.capturedNotConfirmed.length +
    health.stuck.confirmedNotPacked.length +
    health.stuck.shippedNotTracking.length;

  return (
    <>
      <PageHeader
        title="Health"
        description="The parts of the shop that fail silently, checked live on every load."
      />

      <AdminPage className="space-y-6">
        {/*
          First section on the page, above everything else, because it is the
          only one that can invalidate the rest: if the build answering this
          request is not the build that was merged, then every other card is
          reporting truthfully about the wrong code.

          It was written with this comment and rendered third — below the key
          cards and the stuck orders — from 2026-08-20 01:33 until later the
          same night, which is how the owner came to report the card as "not
          on the page". A claim about position belongs next to code that
          actually holds the position.
        */}
        <DeploymentSection deployment={health.deployment} />

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Panel
            label="Razorpay keys"
            tone={health.keyMode.ok ? "good" : "bad"}
            headline={
              health.keyMode.ok
                ? `${health.keyMode.mode} keys on ${health.keyMode.env}`
                : `${health.keyMode.mode} keys on ${health.keyMode.env}`
            }
            body={health.keyMode.ok ? "Matches the deployment." : health.keyMode.message}
          />

          <Panel
            label="Payment webhook"
            tone={
              health.webhook.state === "ok" || health.webhook.state === "idle"
                ? "good"
                : "bad"
            }
            chip={
              health.webhook.state === "never"
                ? "silent"
                : health.webhook.state === "behind"
                  ? "behind"
                  : health.webhook.state === "unknown"
                    ? "unread"
                    : "ok"
            }
            headline={webhookHeadline(health.webhook)}
            body={webhookBody(health.webhook)}
          />

          <Panel
            label="Shiprocket sign-in"
            tone={
              health.shiprocketAuth.state === "locked_out" ||
              health.shiprocketAuth.state === "unreadable"
                ? "bad"
                : "good"
            }
            chip={
              health.shiprocketAuth.state === "locked_out"
                ? "locked out"
                : health.shiprocketAuth.state === "unreadable"
                  ? "unread"
                  : "ok"
            }
            headline={authHeadline(health.shiprocketAuth)}
            body={authBody(health.shiprocketAuth)}
          />

          {/*
            The pickup address, which fails in two very different ways.

            A nickname that no longer matches anything in the Shiprocket panel
            stops shipping loudly, at the counter, on an order somebody has
            already paid for. A pin code that disagrees with the one every quote
            is taken from stops nothing at all — it charges every customer the
            rate for a journey the parcel does not make. The second is the one
            worth a page like this.
          */}
          <Panel
            label="Pickup address"
            tone={
              pickup.state === "ok"
                ? "good"
                : pickup.state === "unknown"
                  ? "warn"
                  : "bad"
            }
            chip={
              pickup.state === "ok"
                ? "ok"
                : pickup.state === "unknown"
                  ? "unread"
                  : pickup.state === "missing"
                    ? "missing"
                    : "wrong"
            }
            headline={pickupHeadline(pickup)}
            body={pickupBody(pickup)}
          />

          <Panel
            label="Shiprocket wallet"
            tone={
              health.wallet.reading.state !== "read"
                ? "warn"
                : health.wallet.low
                  ? "bad"
                  : "good"
            }
            chip={
              health.wallet.reading.state !== "read"
                ? "unread"
                : health.wallet.low
                  ? "low"
                  : "ok"
            }
            headline={
              health.wallet.reading.state === "read"
                ? formatPaise(health.wallet.reading.balancePaise)
                : "Could not read"
            }
            body={
              health.wallet.reading.state === "read"
                ? health.wallet.threshold.state === "set"
                  ? health.wallet.low
                    ? `At or under your ${formatPaise(health.wallet.threshold.paise)} line — recharge before shipping stops.`
                    : `Warning line ${formatPaise(health.wallet.threshold.paise)}.`
                  : "No low-balance line is set, so nothing is watching this number."
                : health.wallet.reading.message
            }
          />

          <Panel
            label="Parcels in flight"
            tone={health.parcelsInFlight === null ? "warn" : "good"}
            chip={health.parcelsInFlight === null ? "unread" : "ok"}
            headline={
              health.parcelsInFlight === null
                ? "Could not read"
                : String(health.parcelsInFlight)
            }
            body={
              health.parcelsInFlight === null
                ? "The in-flight count could not be read."
                : health.parcelsInFlight === 0
                  ? "Nothing is between the courier and a doorstep. The delivery poller checks every 30 minutes; its last run is in the schedule below."
                  : "Shipped, with an AWB, not yet delivered or returned. The delivery poller asks the courier about each every 30 minutes — see poll-deliveries below for its last run."
            }
          />
        </section>

        <section className="space-y-2">
          <h2 className="font-mono text-xs tracking-[0.06em] uppercase">
            Stuck orders{" "}
            {health.stuck.unreadable ? null : (
              <Chip tone={stuckCount === 0 ? "good" : "warn"}>
                {stuckCount === 0 ? "none" : stuckCount}
              </Chip>
            )}
          </h2>
          {health.stuck.unreadable ? (
            <p className="text-destructive text-sm">
              Could not read the orders: {health.stuck.unreadable}
            </p>
          ) : stuckCount === 0 ? (
            <p className="text-muted-foreground text-sm text-pretty">
              Nothing is stuck. Money captured on a pending order past 15
              minutes, a confirmed order untouched for two days, or a shipped
              parcel with no tracking for three would appear here.
            </p>
          ) : (
            <StuckTable
              groups={[
                ["Captured, not confirmed", health.stuck.capturedNotConfirmed],
                ["Confirmed, not packed", health.stuck.confirmedNotPacked],
                ["Shipped, not tracking", health.stuck.shippedNotTracking],
              ]}
            />
          )}
        </section>

        <section className="space-y-2">
          <h2 className="font-mono text-xs tracking-[0.06em] uppercase">
            Stock ledger{" "}
            {health.drift.state !== "unreadable" ? (
              <Chip tone={health.drift.state === "clean" ? "good" : "warn"}>
                {health.drift.state === "clean"
                  ? "reconciles"
                  : `${health.drift.rows.length} drifted`}
              </Chip>
            ) : null}
          </h2>
          {health.drift.state === "unreadable" ? (
            <p className="text-destructive text-sm">
              Could not reconcile: {health.drift.message}
            </p>
          ) : health.drift.state === "clean" ? (
            <p className="text-muted-foreground text-sm text-pretty">
              Every one of {health.drift.variantsChecked} sizes matches its
              movement ledger exactly.
            </p>
          ) : (
            <TableWrap label="Stock drift">
              <Table className="min-w-[32rem]">
                <thead>
                  <tr>
                    <Th>SKU</Th>
                    <Th numeric>On the shelf</Th>
                    <Th numeric>Ledger says</Th>
                    <Th numeric>Drift</Th>
                  </tr>
                </thead>
                <tbody>
                  {health.drift.rows.map((row) => (
                    <tr key={row.sku}>
                      <Td className="font-mono text-xs">{row.sku}</Td>
                      <Td numeric>{row.stock}</Td>
                      <Td numeric>{row.ledger}</Td>
                      <Td numeric>
                        <span className="text-destructive font-mono">
                          {row.drift > 0 ? `+${row.drift}` : row.drift}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </section>

        <section className="space-y-2">
          <h2 className="font-mono text-xs tracking-[0.06em] uppercase">
            Scheduled jobs
          </h2>
          {health.cron.unreadable ? (
            <p className="text-destructive text-sm">
              Could not read the schedule: {health.cron.unreadable}
            </p>
          ) : health.cron.jobs.length === 0 ? (
            <p className="text-destructive text-sm text-pretty">
              No jobs are scheduled at all — the abandoned-order sweep and the
              reconciler should both be here. That is worth a look today.
            </p>
          ) : (
            <TableWrap label="Scheduled jobs">
              <Table className="min-w-[40rem]">
                <thead>
                  <tr>
                    <Th>Job</Th>
                    <Th>Schedule</Th>
                    <Th>Last run</Th>
                    <Th>Result</Th>
                  </tr>
                </thead>
                <tbody>
                  {health.cron.jobs.map((job) => (
                    <tr key={job.jobname}>
                      <Td className="font-mono text-xs">{job.jobname}</Td>
                      <Td className="font-mono text-xs">{job.schedule}</Td>
                      <Td className="text-muted-foreground whitespace-nowrap">
                        {job.lastStarted ? relativeAge(job.lastStarted) : "never"}
                      </Td>
                      <Td>
                        {!job.active ? (
                          <Chip tone="warn">switched off</Chip>
                        ) : job.lastStatus === "succeeded" ? (
                          <Chip tone="good">succeeded</Chip>
                        ) : job.lastStatus === null ? (
                          <Chip tone="neutral">not run yet</Chip>
                        ) : (
                          <Chip tone="warn">{job.lastStatus}</Chip>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </section>
      </AdminPage>
    </>
  );
}

/**
 * What is deployed, and whether it is what was merged.
 *
 * The four states are drawn differently on purpose, and only one of them is
 * green. `expected_unknown` is the one worth being careful about: the build
 * knows its own commit but nothing could be learned about the branch, and the
 * honest rendering of that is a warning that names the missing piece — not a
 * tick, and not silence. This page's standing rule is that it never renders a
 * guess, and "I could not check" is a guess wearing a tick.
 *
 * Both SHAs are always printed when both are known. A verdict without the
 * figures behind it is not something anybody can act on: "drifted" tells the
 * owner to worry, `2e0527b → 317839e` tells them what to redeploy.
 */
function DeploymentSection({
  deployment,
}: {
  deployment: HealthSnapshot["deployment"];
}) {
  return (
    <section className="space-y-2">
      <h2 className="font-mono text-xs tracking-[0.06em] uppercase">
        Deployed build{" "}
        {deployment.state === "in_sync" ? (
          <Chip tone="good">in sync with main</Chip>
        ) : deployment.state === "drifted" ? (
          <Chip tone="bad">behind main</Chip>
        ) : (
          <Chip tone="warn">unverified</Chip>
        )}
      </h2>

      {deployment.state === "unknown" ? (
        <p className="text-sm text-pretty">
          <span className="text-destructive font-medium">
            Cannot tell which commit is running.
          </span>{" "}
          <span className="text-muted-foreground">{deployment.reason}</span>
        </p>
      ) : (
        <div className="border-border rounded-md border p-3 text-sm">
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">Serving</dt>
            <dd className="font-mono">
              {deployment.deployed.slice(0, 7)}
              <span className="text-muted-foreground">
                {" "}
                {deployment.deployed.slice(7)}
              </span>
            </dd>

            {deployment.state === "drifted" ? (
              <>
                <dt className="text-muted-foreground">Tip of {deployment.ref ?? "main"}</dt>
                <dd className="font-mono">
                  {deployment.expected.slice(0, 7)}
                  <span className="text-muted-foreground">
                    {" "}
                    {deployment.expected.slice(7)}
                  </span>
                </dd>
              </>
            ) : null}

            <dt className="text-muted-foreground">Branch</dt>
            <dd>
              {deployment.ref ?? "—"}
              {deployment.environment ? ` · ${deployment.environment}` : ""}
            </dd>
          </dl>

          {deployment.state === "drifted" ? (
            <p className="text-destructive mt-2 text-sm text-pretty">
              The shop is serving an older build than the one on{" "}
              {deployment.ref ?? "main"}. Work that has been merged is not live.
              Check Vercel for a deployment that never built — a refusal before
              the build starts produces no logs and reports as a failed check.
            </p>
          ) : deployment.state === "expected_unknown" ? (
            <p className="text-muted-foreground mt-2 text-sm text-pretty">
              The commit above is running, but it could not be compared against
              the branch, so this is <strong>not</strong> a confirmation that
              the shop is up to date. {deployment.reason}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

/**
 * The chip's word is the condition, not the severity.
 *
 * It used to be derived from the tone — every bad card said "wrong" — and the
 * owner read "WRONG" on a wallet that was merely low. A word that overstates
 * teaches the same lesson as a tick that understates: stop trusting the page.
 * So each card passes the word for the state it is actually in, and the tone
 * only colours it. The default keeps tone-derived words for a caller that has
 * nothing more precise to say.
 */
function Panel({
  label,
  tone,
  chip,
  headline,
  body,
}: {
  label: string;
  tone: "good" | "warn" | "bad";
  chip?: string;
  headline: string;
  body: string;
}) {
  return (
    <div className="border-border rounded-lg border p-3">
      <p className="text-muted-foreground font-mono text-xs tracking-[0.06em] uppercase">
        {label}{" "}
        <Chip tone={tone === "bad" ? "warn" : tone === "warn" ? "neutral" : "good"}>
          {chip ?? (tone === "good" ? "ok" : tone === "warn" ? "check" : "wrong")}
        </Chip>
      </p>
      <p className="mt-1 text-sm font-medium">{headline}</p>
      <p className="text-muted-foreground mt-1 text-xs text-pretty">{body}</p>
    </div>
  );
}

function StuckTable({ groups }: { groups: [string, StuckOrder[]][] }) {
  return (
    <TableWrap label="Stuck orders">
      <Table className="min-w-[44rem]">
        <thead>
          <tr>
            <Th>Order</Th>
            <Th>Kind</Th>
            <Th>What is wrong</Th>
            <Th numeric>Value</Th>
          </tr>
        </thead>
        <tbody>
          {groups.flatMap(([kind, orders]) =>
            orders.map((order) => (
              <tr key={order.id} className="hover:bg-muted/40">
                <Td>
                  <Link
                    href={`/admin/orders/${order.id}`}
                    className="font-mono underline-offset-4 hover:underline"
                  >
                    {order.orderNumber}
                  </Link>
                </Td>
                <Td className="whitespace-nowrap">{kind}</Td>
                <Td className="text-muted-foreground text-pretty">
                  {order.detail}
                </Td>
                <Td numeric>
                  <span className="font-mono">
                    {formatPaise(order.grandTotal)}
                  </span>
                </Td>
              </tr>
            )),
          )}
        </tbody>
      </Table>
    </TableWrap>
  );
}

function webhookHeadline(webhook: HealthSnapshot["webhook"]): string {
  switch (webhook.state) {
    case "ok":
      return `Last real webhook ${relativeAge(webhook.lastEventAt)}`;
    case "idle":
      return "No online payments yet";
    case "never":
      return "Money arrived, no webhook ever";
    case "behind":
      return "Webhooks are behind the money";
    case "unknown":
      return "Could not read";
  }
}

function webhookBody(webhook: HealthSnapshot["webhook"]): string {
  switch (webhook.state) {
    case "ok":
      return "Razorpay is talking to the server, not just to browsers.";
    case "idle":
      return "Nothing to measure until the first online payment.";
    case "never":
      return `An online payment landed ${relativeAge(webhook.lastPaidOrderAt ?? "")} and Razorpay has never once called the webhook. Orders are being confirmed by browsers alone.`;
    case "behind":
      return `The last paid order (${relativeAge(webhook.lastPaidOrderAt)}) is newer than the last webhook (${webhook.lastEventAt ? relativeAge(webhook.lastEventAt) : "never"}).`;
    case "unknown":
      return webhook.message;
  }
}

function authHeadline(auth: HealthSnapshot["shiprocketAuth"]): string {
  switch (auth.state) {
    case "held":
      return "Signed in";
    case "expired":
      return "Token lapsed";
    case "none":
      return "Not signed in yet";
    case "locked_out":
      return "Locked out";
    case "unreadable":
      return "Could not read";
  }
}

function authBody(auth: HealthSnapshot["shiprocketAuth"]): string {
  switch (auth.state) {
    case "held":
      return `Token good until ${new Date(auth.expiresAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" })}. Calls ride it without logging in.`;
    case "expired":
      return "The stored token has lapsed; the next call signs in again by itself. Only a problem if it keeps failing.";
    case "none":
      return "Normal for a quiet spell — the first fulfilment call signs in on its own.";
    case "locked_out":
      return `Sign-in is latched off until ${relativeAge(auth.until)} after repeated failures: ${auth.reason}. Shipping is blocked until the credentials are fixed.`;
    case "unreadable":
      return auth.message;
  }
}

function pickupHeadline(verdict: PickupVerdict): string {
  switch (verdict.state) {
    case "ok":
      return `${verdict.nickname} · ${verdict.postcode}`;
    case "missing":
      return `"${verdict.nickname}" is not on the account`;
    case "pin_mismatch":
      return "Two different pin codes";
    default:
      return "Could not check";
  }
}

function pickupBody(verdict: PickupVerdict): string {
  switch (verdict.state) {
    case "ok":
      /*
        Deliberately not Shiprocket's city. Their pincode table maps 516360 to
        "Cuddapah" — the district's old name, not the town — and printing their
        string here put the wrong town back on an owned surface after every
        content table had been fixed (the 2026-08-15 town sweep could never
        have seen it: this string never lived in this repository or its
        database). The nickname and the PIN are the facts this card exists to
        assert; the city is Shiprocket's decoration, and wrong.
      */
      return `The nickname is on the Shiprocket account, and the pin code here matches the one every delivery charge is quoted from.`;
    case "missing":
      return verdict.available.length
        ? `Shiprocket has ${verdict.available.map((name) => `"${name}"`).join(", ")}. Shipping will fail until the name matches one of them.`
        : "Shiprocket lists no pickup addresses at all. Shipping will fail.";
    case "pin_mismatch":
      return `Shiprocket says ${verdict.shiprocketPostcode} for "${verdict.nickname}", but delivery charges are quoted from ${verdict.settingsPostcode}. Every order is being priced for the wrong journey. Fix the pickup pin code at Settings, or the address in Shiprocket.`;
    default:
      return verdict.detail;
  }
}
