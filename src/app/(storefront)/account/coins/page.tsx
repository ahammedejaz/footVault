import type { Metadata } from "next";

import { GoogleSignInForm } from "@/components/storefront/sign-in";
import { coinProgrammeCopy, getMyCoins } from "@/lib/queries/coins";

export const metadata: Metadata = {
  title: "Vault Coins",
  robots: { index: false, follow: false },
};

/**
 * The customer's coins: the balance, the history in plain language, and
 * what the programme is worth — the "findable page" the brief asks for.
 *
 * Every line is a ledger row, not a computed summary: "Earned 90 coins —
 * order FV-2026-00712" is a fact with a receipt behind it, and a customer
 * disputing a number should be able to point at the exact row.
 */
const REASON_COPY: Record<string, (n: number) => string> = {
  earned: (n) => `Earned ${n} ${n === 1 ? "coin" : "coins"}`,
  redeemed: (n) => `Spent ${Math.abs(n)} ${Math.abs(n) === 1 ? "coin" : "coins"}`,
  reversed: (n) => `${Math.abs(n)} ${Math.abs(n) === 1 ? "coin" : "coins"} taken back`,
  expired: (n) => `${Math.abs(n)} ${Math.abs(n) === 1 ? "coin" : "coins"} expired`,
  adjusted: (n) =>
    n > 0 ? `${n} ${n === 1 ? "coin" : "coins"} added by Foot Vault` : `${Math.abs(n)} ${Math.abs(n) === 1 ? "coin" : "coins"} removed by Foot Vault`,
  released: (n) => `${n} ${n === 1 ? "coin" : "coins"} returned — order cancelled`,
};

export default async function CoinsPage() {
  const [mine, copy] = await Promise.all([getMyCoins(), coinProgrammeCopy()]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <h1 className="font-display text-4xl font-extrabold tracking-[-0.03em] uppercase">
        Vault Coins
      </h1>

      {!mine ? (
        <div className="border-border mt-8 rounded-lg border p-6 text-center">
          <p className="text-base text-pretty">
            Coins live on your account. Sign in to see your balance and
            history.
          </p>
          <div className="mx-auto mt-5 max-w-xs">
            <GoogleSignInForm next="/account/coins" />
          </div>
        </div>
      ) : (
        <>
          <p className="mt-6 font-mono text-5xl font-medium tabular-nums">
            {mine.balance}
            <span className="text-muted-foreground ml-2 text-base">
              {mine.balance === 1 ? "coin" : "coins"}
            </span>
          </p>

          <div className="border-border mt-6 space-y-2 rounded-lg border p-4 text-sm">
            <p className="text-pretty">{copy.earning}</p>
            <p className="text-muted-foreground text-pretty">{copy.spending}</p>
          </div>

          <h2 className="mt-10 font-mono text-xs tracking-[0.06em] uppercase">
            History
          </h2>
          {mine.history.length === 0 ? (
            <p className="text-muted-foreground mt-3 text-sm text-pretty">
              Nothing yet. Coins arrive when a parcel does — each delivered
              order credits them automatically.
            </p>
          ) : (
            <ul className="divide-border mt-3 divide-y">
              {mine.history.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-baseline justify-between gap-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm">
                      {(REASON_COPY[entry.reason] ?? REASON_COPY.adjusted!)(
                        entry.delta,
                      )}
                      {entry.orderNumber ? ` — order ${entry.orderNumber}` : ""}
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      <time dateTime={entry.createdAt}>
                        {new Date(entry.createdAt).toLocaleDateString("en-IN", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </time>
                      {entry.reason === "earned" && entry.expiresAt
                        ? ` · lasts until ${new Date(entry.expiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`
                        : ""}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 font-mono text-sm font-medium tabular-nums ${entry.delta < 0 ? "text-muted-foreground" : ""}`}
                  >
                    {entry.delta > 0 ? `+${entry.delta}` : entry.delta}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
