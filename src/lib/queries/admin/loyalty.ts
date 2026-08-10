import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { maybeRow, rows } from "@/lib/queries/run";

/**
 * The owner's read of the coin programme. Everything here is derived from
 * the ledger at read time — there is no balance column anywhere to trust or
 * to drift, which is the design being paid off.
 *
 * Through the service role behind the admin guard: the loyalty settings row
 * is private, and the balances list joins profiles across every customer.
 */

export type LoyaltySettings = {
  enabled: boolean;
  earnRupeesPerCoin: number | null;
  coinValuePaise: number | null;
  coinMaxPercentOfOrder: number | null;
  coinMaxCoinsPerOrder: number | null;
  coinMinimumBalance: number | null;
  coinExpiryMonths: number | null;
};

export async function getLoyaltySettings(): Promise<LoyaltySettings> {
  const row = await maybeRow<{
    value: {
      enabled?: boolean;
      earn_rupees_per_coin?: number;
      coin_value_paise?: number;
      coin_max_percent_of_order?: number;
      coin_max_coins_per_order?: number;
      coin_minimum_balance?: number;
      coin_expiry_months?: number;
    };
  }>(
    "admin.loyalty.settings",
    createAdminClient()
      .from("site_settings")
      .select("value")
      .eq("key", "loyalty")
      .maybeSingle(),
  );
  const value = row?.value ?? {};
  const number = (candidate: unknown): number | null =>
    typeof candidate === "number" && Number.isFinite(candidate)
      ? candidate
      : null;
  return {
    enabled: value.enabled === true,
    earnRupeesPerCoin: number(value.earn_rupees_per_coin),
    coinValuePaise: number(value.coin_value_paise),
    coinMaxPercentOfOrder: number(value.coin_max_percent_of_order),
    coinMaxCoinsPerOrder: number(value.coin_max_coins_per_order),
    coinMinimumBalance: number(value.coin_minimum_balance),
    coinExpiryMonths: number(value.coin_expiry_months),
  };
}

export type CoinBalanceRow = {
  userId: string;
  name: string | null;
  balance: number;
  earned: number;
  redeemed: number;
  disabled: boolean;
  lastActivity: string;
};

/**
 * Every customer who has ever touched a coin, balances derived by summing
 * their ledgers in one pass. Human-scale by construction: rows exist only
 * for customers with coin history, and the shop's whole customer count is
 * two digits.
 */
export async function listCoinBalances(): Promise<CoinBalanceRow[]> {
  const admin = createAdminClient();
  const [transactions, accounts, profiles] = await Promise.all([
    rows<{ user_id: string; delta: number; reason: string; created_at: string }>(
      "admin.loyalty.ledger",
      admin
        .from("coin_transactions")
        .select("user_id, delta, reason, created_at"),
    ),
    rows<{ user_id: string; coins_disabled: boolean }>(
      "admin.loyalty.accounts",
      admin.from("coin_accounts").select("user_id, coins_disabled"),
    ),
    rows<{ id: string; full_name: string | null }>(
      "admin.loyalty.profiles",
      admin.from("profiles").select("id, full_name"),
    ),
  ]);

  const disabled = new Map(accounts.map((a) => [a.user_id, a.coins_disabled]));
  const names = new Map(profiles.map((p) => [p.id, p.full_name]));

  const byUser = new Map<string, CoinBalanceRow>();
  for (const row of transactions) {
    const entry = byUser.get(row.user_id) ?? {
      userId: row.user_id,
      name: names.get(row.user_id) ?? null,
      balance: 0,
      earned: 0,
      redeemed: 0,
      disabled: disabled.get(row.user_id) ?? false,
      lastActivity: row.created_at,
    };
    entry.balance += row.delta;
    if (row.reason === "earned") entry.earned += row.delta;
    if (row.reason === "redeemed") entry.redeemed += Math.abs(row.delta);
    if (row.created_at > entry.lastActivity) entry.lastActivity = row.created_at;
    byUser.set(row.user_id, entry);
  }
  // Accounts with a disable flag but no ledger still deserve a row.
  for (const account of accounts) {
    if (!byUser.has(account.user_id)) {
      byUser.set(account.user_id, {
        userId: account.user_id,
        name: names.get(account.user_id) ?? null,
        balance: 0,
        earned: 0,
        redeemed: 0,
        disabled: account.coins_disabled,
        lastActivity: "",
      });
    }
  }
  return [...byUser.values()].sort((a, b) => b.balance - a.balance);
}

export type CoinLedgerEntry = {
  id: string;
  delta: number;
  reason: string;
  orderNumber: string | null;
  actorName: string | null;
  note: string | null;
  expiresAt: string | null;
  createdAt: string;
};

export async function coinHistoryFor(userId: string): Promise<CoinLedgerEntry[]> {
  const found = await rows<{
    id: string;
    delta: number;
    reason: string;
    note: string | null;
    expires_at: string | null;
    created_at: string;
    order: { order_number: string } | null;
    actor_profile: { full_name: string | null } | null;
  }>(
    "admin.loyalty.history",
    createAdminClient()
      .from("coin_transactions")
      .select(
        "id, delta, reason, note, expires_at, created_at, order:orders(order_number), actor_profile:profiles!coin_transactions_actor_fkey(full_name)",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(500),
  );
  return found.map((row) => ({
    id: row.id,
    delta: row.delta,
    reason: row.reason,
    orderNumber: row.order?.order_number ?? null,
    actorName: row.actor_profile?.full_name ?? null,
    note: row.note,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }));
}

export type AbuseSignals = {
  /** Phone numbers appearing on orders across more than one account. */
  sharedPhones: { phone: string; userIds: string[]; orders: number }[];
  /** Canonicalised addresses shared across accounts. */
  sharedAddresses: { addressKey: string; userIds: string[]; orders: number }[];
  /** Balances below zero — a reversal outran a spend; honest, and worth eyes. */
  negativeBalances: { userId: string; balance: number }[];
  /** Positive coins with zero delivered orders — only manual grants can do this. */
  coinsWithoutDelivery: { userId: string; balance: number }[];
  /** Redemptions in the last 7 days, busiest first. */
  redemptionVelocity: { userId: string; redemptions: number }[];
};

export async function abuseSignals(): Promise<AbuseSignals> {
  const admin = createAdminClient();

  const [orders, ledger] = await Promise.all([
    rows<{
      user_id: string | null;
      contact_phone: string | null;
      shipping_address_key: string | null;
      delivered_at: string | null;
    }>(
      "admin.loyalty.orders",
      admin
        .from("orders")
        .select("user_id, contact_phone, shipping_address_key, delivered_at"),
    ),
    rows<{ user_id: string; delta: number; reason: string; created_at: string }>(
      "admin.loyalty.signalLedger",
      admin
        .from("coin_transactions")
        .select("user_id, delta, reason, created_at"),
    ),
  ]);

  const byPhone = new Map<string, { users: Set<string>; orders: number }>();
  const byAddress = new Map<string, { users: Set<string>; orders: number }>();
  const delivered = new Set<string>();
  for (const order of orders) {
    if (order.user_id && order.delivered_at) delivered.add(order.user_id);
    if (order.contact_phone) {
      const entry = byPhone.get(order.contact_phone) ?? {
        users: new Set<string>(),
        orders: 0,
      };
      if (order.user_id) entry.users.add(order.user_id);
      entry.orders += 1;
      byPhone.set(order.contact_phone, entry);
    }
    if (order.shipping_address_key && order.shipping_address_key !== ":") {
      const entry = byAddress.get(order.shipping_address_key) ?? {
        users: new Set<string>(),
        orders: 0,
      };
      if (order.user_id) entry.users.add(order.user_id);
      entry.orders += 1;
      byAddress.set(order.shipping_address_key, entry);
    }
  }

  const balances = new Map<string, number>();
  const recentRedemptions = new Map<string, number>();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const row of ledger) {
    balances.set(row.user_id, (balances.get(row.user_id) ?? 0) + row.delta);
    if (row.reason === "redeemed" && Date.parse(row.created_at) > weekAgo) {
      recentRedemptions.set(
        row.user_id,
        (recentRedemptions.get(row.user_id) ?? 0) + 1,
      );
    }
  }

  return {
    sharedPhones: [...byPhone.entries()]
      .filter(([, entry]) => entry.users.size > 1)
      .map(([phone, entry]) => ({
        phone,
        userIds: [...entry.users],
        orders: entry.orders,
      })),
    sharedAddresses: [...byAddress.entries()]
      .filter(([, entry]) => entry.users.size > 1)
      .map(([addressKey, entry]) => ({
        addressKey,
        userIds: [...entry.users],
        orders: entry.orders,
      })),
    negativeBalances: [...balances.entries()]
      .filter(([, balance]) => balance < 0)
      .map(([userId, balance]) => ({ userId, balance })),
    coinsWithoutDelivery: [...balances.entries()]
      .filter(([userId, balance]) => balance > 0 && !delivered.has(userId))
      .map(([userId, balance]) => ({ userId, balance })),
    redemptionVelocity: [...recentRedemptions.entries()]
      .map(([userId, redemptions]) => ({ userId, redemptions }))
      .sort((a, b) => b.redemptions - a.redemptions)
      .slice(0, 10),
  };
}

/**
 * What the shop owes, in coins and — when the owner has priced a coin — in
 * rupees. The sum of every POSITIVE balance: a negative balance is money
 * owed to the shop and must not quietly offset the liability figure.
 */
export async function coinLiability(): Promise<{
  coins: number;
  rupees: number | null;
}> {
  const [ledger, settings] = await Promise.all([
    rows<{ user_id: string; delta: number }>(
      "admin.loyalty.liability",
      createAdminClient().from("coin_transactions").select("user_id, delta"),
    ),
    getLoyaltySettings(),
  ]);
  const balances = new Map<string, number>();
  for (const row of ledger) {
    balances.set(row.user_id, (balances.get(row.user_id) ?? 0) + row.delta);
  }
  const coins = [...balances.values()]
    .filter((balance) => balance > 0)
    .reduce((sum, balance) => sum + balance, 0);
  return {
    coins,
    rupees:
      settings.coinValuePaise !== null
        ? Math.round((coins * settings.coinValuePaise) / 100)
        : null,
  };
}
