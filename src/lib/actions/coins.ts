"use server";

import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { planCoinSpend, type CoinSpendPlan } from "@/lib/coins/redeem";

/**
 * The checkout's coin preview.
 *
 * The three figures arrive from the browser, and that is acceptable for
 * exactly one reason: this answer only ever DRAWS a checkbox. The binding
 * numbers are recomputed by `placeOrder` from its own quote and enforced by
 * `create_order_with_stock` under the account lock — a caller lying to this
 * action fools nobody but their own preview.
 */
const schema = z.object({
  grandTotalPaise: z.number().int().min(0).max(100_000_000),
  advancePaise: z.number().int().min(0).max(100_000_000),
  balancePaise: z.number().int().min(0).max(100_000_000),
});

export async function previewCoinSpend(
  input: unknown,
): Promise<CoinSpendPlan> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { available: false, why: "no_room" };

  const user = await getCurrentUser();
  return planCoinSpend({
    userId: user?.id ?? null,
    grandTotalPaise: parsed.data.grandTotalPaise,
    advancePaise: parsed.data.advancePaise,
    balancePaise: parsed.data.balancePaise,
  });
}
