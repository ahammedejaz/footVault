"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminAction, type AdminResult } from "@/lib/admin/guard";

/**
 * The owner's controls over Vault Coins. All three go through `adminAction`
 * (the lint rule would fail the build otherwise) and write with the service
 * role, because the client holds no write grant on any coin table.
 */

const settingsSchema = z.object({
  enabled: z.boolean(),
  // Every number is nullable: unset is a legitimate, safe state — the
  // programme simply does not run that half. None has a default; the owner
  // types each one or leaves it empty.
  earnRupeesPerCoin: z.number().int().min(1).max(100_000).nullable(),
  coinValuePaise: z
    .number()
    .int()
    .min(100)
    .max(1_000_000)
    .multipleOf(100, {
      message:
        "A coin must be worth a whole number of rupees — the courier collects cash in whole rupees.",
    })
    .nullable(),
  coinMaxPercentOfOrder: z.number().int().min(1).max(100).nullable(),
  coinMaxCoinsPerOrder: z.number().int().min(1).max(1_000_000).nullable(),
  coinMinimumBalance: z.number().int().min(0).max(1_000_000).nullable(),
  coinExpiryMonths: z.number().int().min(1).max(120).nullable(),
});

export async function saveLoyaltySettings(
  input: unknown,
): Promise<AdminResult<{ saved: true }>> {
  return adminAction<{ saved: true }>(
    "saveLoyaltySettings",
    "adminMutation",
    async ({ elevated }) => {
      const parsed = settingsSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          reason: "invalid",
          message: parsed.error.issues[0]?.message ?? "That did not parse.",
        };
      }

      // Absent keys stay absent: an unset number is stored as no key at
      // all, which is what the SQL reads as "the owner has not decided".
      const value: Record<string, number | boolean> = {
        enabled: parsed.data.enabled,
      };
      if (parsed.data.earnRupeesPerCoin !== null)
        value.earn_rupees_per_coin = parsed.data.earnRupeesPerCoin;
      if (parsed.data.coinValuePaise !== null)
        value.coin_value_paise = parsed.data.coinValuePaise;
      if (parsed.data.coinMaxPercentOfOrder !== null)
        value.coin_max_percent_of_order = parsed.data.coinMaxPercentOfOrder;
      if (parsed.data.coinMaxCoinsPerOrder !== null)
        value.coin_max_coins_per_order = parsed.data.coinMaxCoinsPerOrder;
      if (parsed.data.coinMinimumBalance !== null)
        value.coin_minimum_balance = parsed.data.coinMinimumBalance;
      if (parsed.data.coinExpiryMonths !== null)
        value.coin_expiry_months = parsed.data.coinExpiryMonths;

      const { error } = await elevated()
        .from("site_settings")
        .update({ value })
        .eq("key", "loyalty");
      if (error) {
        return { ok: false, reason: "error", message: error.message };
      }
      revalidatePath("/admin/loyalty");
      return { ok: true, saved: true };
    },
  );
}

const adjustSchema = z.object({
  userId: z.uuid(),
  delta: z
    .number()
    .int()
    .refine((value) => value !== 0, { message: "Zero coins moves nothing." })
    .refine((value) => Math.abs(value) <= 100_000, {
      message: "Keep an adjustment under a lakh of coins.",
    }),
  reason: z
    .string()
    .trim()
    .min(3, "Say why — the reason is written into the ledger.")
    .max(500),
});

/**
 * Goodwill and corrections, written to the ledger as `adjusted` like
 * everything else — with the actor and the required reason. There is no
 * balance to edit; there are only rows to add, which is the point.
 */
export async function adjustCoins(
  input: unknown,
): Promise<AdminResult<{ adjusted: true }>> {
  return adminAction<{ adjusted: true }>(
    "adjustCoins",
    "adminMutation",
    async ({ actor, elevated }) => {
      const parsed = adjustSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          reason: "invalid",
          message: parsed.error.issues[0]?.message ?? "That did not parse.",
        };
      }

      const { error } = await elevated().from("coin_transactions").insert({
        user_id: parsed.data.userId,
        delta: parsed.data.delta,
        reason: "adjusted",
        actor: actor.id,
        note: parsed.data.reason,
      });
      if (error) {
        return { ok: false, reason: "error", message: error.message };
      }
      revalidatePath("/admin/loyalty");
      return { ok: true, adjusted: true };
    },
  );
}

const disableSchema = z.object({
  userId: z.uuid(),
  disabled: z.boolean(),
});

/** The per-customer switch: no earning, no spending, history untouched. */
export async function setCoinsDisabled(
  input: unknown,
): Promise<AdminResult<{ disabled: boolean }>> {
  return adminAction<{ disabled: boolean }>(
    "setCoinsDisabled",
    "adminMutation",
    async ({ elevated }) => {
      const parsed = disableSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          reason: "invalid",
          message: parsed.error.issues[0]?.message ?? "That did not parse.",
        };
      }

      const { error } = await elevated().from("coin_accounts").upsert({
        user_id: parsed.data.userId,
        coins_disabled: parsed.data.disabled,
      });
      if (error) {
        return { ok: false, reason: "error", message: error.message };
      }
      revalidatePath("/admin/loyalty");
      return { ok: true, disabled: parsed.data.disabled };
    },
  );
}
