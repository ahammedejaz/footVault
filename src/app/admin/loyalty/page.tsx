import type { Metadata } from "next";

import { BalanceRowActions } from "@/components/admin/loyalty/balance-row-actions";
import { LoyaltySettingsForm } from "@/components/admin/loyalty/loyalty-settings-form";
import { AdminPage, Chip, EmptyState, PageHeader } from "@/components/admin/ui";
import { formatPaise } from "@/lib/format";
import {
  abuseSignals,
  coinHistoryFor,
  coinLiability,
  getLoyaltySettings,
  listCoinBalances,
} from "@/lib/queries/admin/loyalty";

export const metadata: Metadata = { title: "Vault Coins" };
export const dynamic = "force-dynamic";

/**
 * The coin programme, from the owner's chair: what it costs (the liability,
 * first), the switchboard, every balance with its full history a click away,
 * and the abuse signals — surfaced, never acted on automatically.
 */
export default async function AdminLoyaltyPage({
  searchParams,
}: {
  searchParams: Promise<{ history?: string }>;
}) {
  const sp = await searchParams;
  const [settings, balances, liability, signals] = await Promise.all([
    getLoyaltySettings(),
    listCoinBalances(),
    coinLiability(),
    abuseSignals(),
  ]);
  const historyFor = /^[0-9a-f-]{36}$/i.test(sp.history ?? "")
    ? sp.history!
    : null;
  const history = historyFor ? await coinHistoryFor(historyFor) : null;

  const unsetCount = [
    settings.earnRupeesPerCoin,
    settings.coinValuePaise,
    settings.coinMaxPercentOfOrder,
    settings.coinMaxCoinsPerOrder,
    settings.coinMinimumBalance,
  ].filter((value) => value === null).length;

  return (
    <AdminPage>
      <PageHeader
        title="Vault Coins"
        description="Every coin out there is money this shop owes against a future order. This page is where that debt is priced, capped, and watched."
      />

      {/* ── the number that matters first ─────────────────────────────── */}
      <section
        aria-labelledby="liability-heading"
        className="border-border mt-6 rounded-lg border p-4"
      >
        <h2
          id="liability-heading"
          className="font-mono text-xs tracking-[0.06em] uppercase"
        >
          Outstanding liability
        </h2>
        <p className="mt-1 font-mono text-3xl font-medium tabular-nums">
          {liability.rupees !== null
            ? formatPaise(liability.rupees * 100)
            : `${liability.coins} coins`}
          {liability.rupees !== null ? (
            <span className="text-muted-foreground ml-2 text-base">
              ({liability.coins} coins)
            </span>
          ) : null}
        </p>
        <p className="text-muted-foreground mt-1 max-w-prose text-sm text-pretty">
          {liability.rupees === null
            ? "In coins only, because no coin value is set yet — the moment you price a coin, this becomes rupees."
            : "The sum of every positive balance at today's coin value. Negative balances (money owed back to the shop) are deliberately not netted off."}
          {settings.coinExpiryMonths === null
            ? " With no expiry set, this number only ever grows."
            : ""}
        </p>
      </section>

      {/* ── the state of the programme, in one sentence ───────────────── */}
      <p className="border-border bg-fog/40 mt-4 rounded-lg border p-3 text-sm text-pretty">
        {!settings.enabled
          ? "The programme is OFF. Nothing earns and nothing spends, whatever the numbers below say."
          : settings.earnRupeesPerCoin === null
            ? "The programme is on but NOT EARNING — no earn rate is set, so deliveries credit nothing."
            : unsetCount > 0
              ? "Earning is live. Spending is NOT — at least one redemption number below is still empty, so coins accrue and cannot be spent yet."
              : "Earning and spending are both live."}
      </p>

      {/* ── the switchboard ───────────────────────────────────────────── */}
      <section aria-labelledby="settings-heading" className="mt-8">
        <h2
          id="settings-heading"
          className="font-mono text-xs tracking-[0.06em] uppercase"
        >
          Settings
        </h2>
        <div className="mt-3">
          <LoyaltySettingsForm initial={settings} />
        </div>
      </section>

      {/* ── every balance ─────────────────────────────────────────────── */}
      <section aria-labelledby="balances-heading" className="mt-10">
        <h2
          id="balances-heading"
          className="font-mono text-xs tracking-[0.06em] uppercase"
        >
          Balances
        </h2>
        {balances.length === 0 ? (
          <EmptyState
            title="Nobody holds a coin yet"
            body="Coins are minted when a parcel is delivered. The first delivered order with the earn rate set will put the first row here."
          />
        ) : (
          <ul className="divide-border border-border mt-3 divide-y rounded-lg border">
            {balances.map((row) => (
              <li key={row.userId} className="p-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono text-lg font-medium tabular-nums">
                    {row.balance}
                  </span>
                  <span className="text-sm font-medium">
                    {row.name ?? "Customer"}
                  </span>
                  {row.disabled ? <Chip tone="bad">coins disabled</Chip> : null}
                  {row.balance < 0 ? <Chip tone="warn">owes coins</Chip> : null}
                  <span className="text-muted-foreground text-xs">
                    earned {row.earned} · spent {row.redeemed}
                  </span>
                  <a
                    href={`/admin/loyalty?history=${row.userId}`}
                    className="hit-44 relative font-mono text-xs tracking-[0.06em] uppercase underline underline-offset-2"
                  >
                    Full history
                  </a>
                </div>
                <div className="mt-2">
                  <BalanceRowActions userId={row.userId} disabled={row.disabled} />
                </div>
                {historyFor === row.userId && history ? (
                  <ul className="divide-border bg-fog/40 mt-3 divide-y rounded-lg p-3">
                    {history.map((entry) => (
                      <li
                        key={entry.id}
                        className="flex items-baseline justify-between gap-3 py-2 text-sm"
                      >
                        <span className="min-w-0">
                          {entry.reason}
                          {entry.orderNumber ? ` — ${entry.orderNumber}` : ""}
                          {entry.note ? ` — ${entry.note}` : ""}
                          {entry.actorName ? ` (by ${entry.actorName})` : ""}
                          <span className="text-muted-foreground">
                            {" "}
                            · {new Date(entry.createdAt).toLocaleString("en-IN")}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono tabular-nums">
                          {entry.delta > 0 ? `+${entry.delta}` : entry.delta}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── the watch floor ───────────────────────────────────────────── */}
      <section aria-labelledby="signals-heading" className="mt-10">
        <h2
          id="signals-heading"
          className="font-mono text-xs tracking-[0.06em] uppercase"
        >
          Abuse signals
        </h2>
        <p className="text-muted-foreground mt-1 max-w-prose text-sm text-pretty">
          Surfaced, never acted on automatically. The address match is
          deliberately crude — lowercased, punctuation stripped, first line
          plus PIN — so it catches copies, not paraphrases.
        </p>

        <div className="mt-3 space-y-3">
          <SignalBlock
            title="Accounts sharing a phone number"
            rows={signals.sharedPhones.map(
              (signal) =>
                `${signal.phone} — ${signal.userIds.length} accounts, ${signal.orders} orders`,
            )}
            empty="No phone number appears on more than one account's orders."
          />
          <SignalBlock
            title="Accounts sharing a delivery address"
            rows={signals.sharedAddresses.map(
              (signal) =>
                `${signal.addressKey} — ${signal.userIds.length} accounts, ${signal.orders} orders`,
            )}
            empty="No two accounts share a canonicalised address."
          />
          <SignalBlock
            title="Negative balances (owed back after a refund)"
            rows={signals.negativeBalances.map(
              (signal) => `${signal.balance} coins — customer ${signal.userId.slice(0, 8)}…`,
            )}
            empty="Nobody owes coins back."
          />
          <SignalBlock
            title="Coins with no delivered order"
            rows={signals.coinsWithoutDelivery.map(
              (signal) =>
                `${signal.balance} coins — customer ${signal.userId.slice(0, 8)}… (only a manual adjustment can do this)`,
            )}
            empty="Every positive balance traces to a delivered parcel."
          />
          <SignalBlock
            title="Redemption velocity, last 7 days"
            rows={signals.redemptionVelocity.map(
              (signal) =>
                `${signal.redemptions} redemptions — customer ${signal.userId.slice(0, 8)}…`,
            )}
            empty="No redemptions in the last week."
          />
        </div>
      </section>
    </AdminPage>
  );
}

function SignalBlock({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: string[];
  empty: string;
}) {
  return (
    <div className="border-border rounded-lg border p-4">
      <h3 className="text-sm font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-muted-foreground mt-1 text-sm">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {rows.map((row) => (
            <li key={row} className="font-mono text-sm">
              {row}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
