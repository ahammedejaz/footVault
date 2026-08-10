import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { maybeRow, rows } from "@/lib/queries/run";

/**
 * The redemption arithmetic, for the PREVIEW. The binding decision is
 * `create_order_with_stock`'s coin block, under the account's row lock —
 * this module exists so the checkout can offer an amount the function will
 * then accept, and so `placeOrder` computes the p_coin_spend it passes from
 * the same rules the SQL enforces. If the two ever disagree, the SQL wins
 * and the customer sees a refusal instead of a wrong charge; the gate
 * asserts they agree.
 *
 * The spend rule is deliberately all-or-max (owner's standing rule: the
 * simpler rule that is easy to explain on screen beats the more flexible
 * one needing a paragraph): ticking "use my coins" spends as many as the
 * caps allow, and the preview names the number before the customer commits.
 *
 * Two caps, whichever binds lower applies (owner, 2026-08-11):
 * `coin_max_percent_of_order` binds on big balances against small orders;
 * `coin_max_coins_per_order` binds on big balances against big orders. The
 * intent is that every order is part-paid in money.
 */

export type CoinSpendPlan =
  | {
      available: true;
      coins: number;
      paise: number;
      /** Which rule stopped it going higher, for the sentence on screen. */
      boundBy: "balance" | "percent_cap" | "coin_cap" | "order_room" | "razorpay_floor";
    }
  | {
      available: false;
      why:
        | "signed_out"
        | "off"
        | "unset"
        | "disabled"
        | "no_coins"
        | "below_minimum"
        | "no_room";
      /** The floor, when why is below_minimum. */
      minimumBalance?: number;
    };

export async function planCoinSpend(input: {
  userId: string | null;
  /** The quoted totals the customer is looking at. */
  grandTotalPaise: number;
  advancePaise: number;
  balancePaise: number;
}): Promise<CoinSpendPlan> {
  if (!input.userId) return { available: false, why: "signed_out" };

  const admin = createAdminClient();

  const [setting, account, ledger] = await Promise.all([
    maybeRow<{
      value: {
        enabled?: boolean;
        coin_value_paise?: number;
        coin_max_percent_of_order?: number;
        coin_max_coins_per_order?: number;
        coin_minimum_balance?: number;
      };
    }>(
      "coins.plan.settings",
      admin.from("site_settings").select("value").eq("key", "loyalty").maybeSingle(),
    ),
    maybeRow<{ coins_disabled: boolean }>(
      "coins.plan.account",
      admin
        .from("coin_accounts")
        .select("coins_disabled")
        .eq("user_id", input.userId)
        .maybeSingle(),
    ),
    rows<{ delta: number; reason: string; expires_at: string | null }>(
      "coins.plan.ledger",
      admin
        .from("coin_transactions")
        .select("delta, reason, expires_at")
        .eq("user_id", input.userId),
    ),
  ]);

  if (setting?.value?.enabled !== true) {
    return { available: false, why: "off" };
  }
  const valuePaise = setting?.value?.coin_value_paise;
  const pctCap = setting?.value?.coin_max_percent_of_order;
  const coinCap = setting?.value?.coin_max_coins_per_order;
  const minBalance = setting?.value?.coin_minimum_balance;
  if (
    typeof valuePaise !== "number" ||
    valuePaise <= 0 ||
    valuePaise % 100 !== 0 ||
    typeof pctCap !== "number" ||
    typeof coinCap !== "number" ||
    typeof minBalance !== "number"
  ) {
    return { available: false, why: "unset" };
  }
  if (account?.coins_disabled) return { available: false, why: "disabled" };

  // Same conservative expiry rule as the SQL: an earned cohort past its
  // expires_at cannot spend, swept or not.
  const now = Date.now();
  const usable = ledger.reduce((sum, row) => {
    if (
      row.reason === "earned" &&
      row.expires_at !== null &&
      Date.parse(row.expires_at) < now
    ) {
      return sum;
    }
    return sum + row.delta;
  }, 0);

  if (usable <= 0) return { available: false, why: "no_coins" };
  if (usable < minBalance) {
    return { available: false, why: "below_minimum", minimumBalance: minBalance };
  }

  /** Where the money can go: the cash at the door for COD, the card for prepaid. */
  const paysOnDelivery = input.balancePaise > 0;
  const room = paysOnDelivery ? input.balancePaise : input.advancePaise;

  const byPercent = Math.floor(
    Math.floor((input.grandTotalPaise * pctCap) / 100) / valuePaise,
  );
  const byRoom = Math.floor(room / valuePaise);

  let coins = usable;
  let boundBy: "balance" | "percent_cap" | "coin_cap" | "order_room" | "razorpay_floor" =
    "balance";
  if (byPercent < coins) {
    coins = byPercent;
    boundBy = "percent_cap";
  }
  if (coinCap < coins) {
    coins = coinCap;
    boundBy = "coin_cap";
  }
  if (byRoom < coins) {
    coins = byRoom;
    boundBy = "order_room";
  }
  if (coins <= 0) return { available: false, why: "no_room" };

  /**
   * The Razorpay floor, from the customer's side: a prepaid remainder of
   * 1–99 paise is an order that cancels itself, so the plan either settles
   * the advance ENTIRELY or leaves at least ₹1 on the card. Coins are whole
   * rupees, so stepping one coin down always clears the window.
   */
  if (!paysOnDelivery) {
    const remainder = input.advancePaise - coins * valuePaise;
    if (remainder > 0 && remainder < 100) {
      coins -= 1;
      boundBy = "razorpay_floor";
      if (coins <= 0) return { available: false, why: "no_room" };
    }
  }

  return { available: true, coins, paise: coins * valuePaise, boundBy };
}
