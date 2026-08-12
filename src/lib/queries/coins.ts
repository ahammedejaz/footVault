import "server-only";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { maybeRow, rows } from "@/lib/queries/run";

/**
 * The customer's own coins, through their own RLS client — the SELECT
 * policy is the door, so a signed-out or wrong session reads nothing.
 * Balance is computed here as sum(delta) over their rows because that IS
 * the definition: no balance column exists anywhere, deliberately.
 */

export type CoinHistoryEntry = {
  id: string;
  delta: number;
  reason: "earned" | "redeemed" | "reversed" | "expired" | "adjusted";
  orderNumber: string | null;
  note: string | null;
  expiresAt: string | null;
  createdAt: string;
};

export async function getMyCoins(): Promise<{
  balance: number;
  history: CoinHistoryEntry[];
} | null> {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;

  const found = await rows<{
    id: string;
    delta: number;
    reason: CoinHistoryEntry["reason"];
    note: string | null;
    expires_at: string | null;
    created_at: string;
    order: { order_number: string } | null;
  }>(
    "coins.mine",
    supabase
      .from("coin_transactions")
      .select(
        "id, delta, reason, note, expires_at, created_at, order:orders(order_number)",
      )
      .order("created_at", { ascending: false })
      .limit(500),
  );

  return {
    balance: found.reduce((sum, row) => sum + row.delta, 0),
    history: found.map((row) => ({
      id: row.id,
      delta: row.delta,
      reason: row.reason,
      orderNumber: row.order?.order_number ?? null,
      note: row.note,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    })),
  };
}

/**
 * What the programme is worth to a customer right now, in words the page
 * can print. Server-rendered from the PRIVATE loyalty row (the raw numbers
 * are margin and never reach a browser as data — only as this copy).
 */
export async function coinProgrammeCopy(): Promise<{
  earning: string;
  spending: string;
}> {
  const setting = await maybeRow<{
    value: {
      earn_rupees_per_coin?: number;
      coin_value_paise?: number;
      coin_expiry_months?: number;
    };
  }>(
    "coins.programme",
    createAdminClient()
      .from("site_settings")
      .select("value")
      .eq("key", "loyalty")
      .maybeSingle(),
  );

  const earnRate = setting?.value?.earn_rupees_per_coin;
  const valuePaise = setting?.value?.coin_value_paise;
  const expiryMonths = setting?.value?.coin_expiry_months;

  const earning =
    typeof earnRate === "number" && earnRate > 0
      ? `You earn 1 coin for every ₹${earnRate} spent on shoes, credited when the parcel is delivered.` +
        (typeof expiryMonths === "number" && expiryMonths > 0
          ? ` Coins last ${expiryMonths} months from delivery.`
          : "")
      : "Coins are credited when a parcel is delivered. Earning is not switched on yet.";

  const spending =
    typeof valuePaise === "number" && valuePaise > 0
      ? `Each coin is worth ₹${Math.floor(valuePaise / 100)} at checkout.`
      : "Spending coins at checkout is coming soon — everything you earn now will be waiting.";

  return { earning, spending };
}
