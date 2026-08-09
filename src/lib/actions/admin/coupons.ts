"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminAction, type AdminResult } from "@/lib/admin/guard";
import { likePattern } from "@/lib/admin/list-params";
import { rows } from "@/lib/queries/run";

/**
 * The owner's side of coupons (§9F): create, edit, switch on and off, aim at
 * specific customers, and delete — but only a code nothing has redeemed.
 *
 * **Value semantics are exact, not interpreted.** A percent coupon's `value`
 * is whole percent (1–100); a fixed coupon's `value` is paise. The form owns
 * converting rupees to paise so this file never guesses which unit it was
 * handed — a guess here is a discount that is a hundred times too large.
 *
 * **Deleting a used coupon is refused**, the same shape as deleting a brand
 * with products: `coupon_redemptions.coupon_id` has no cascade, on purpose —
 * the ledger must outlive the coupon's row in the admin's eyes, because "who
 * used this and what did it cost" is a question about past orders. Switch it
 * off instead; the storefront treats an inactive code as unknown.
 *
 * No cache tags to bust: coupons are read per-request through the admin
 * client and at redemption inside the order transaction. Nothing about them
 * sits in the chrome or catalog caches.
 */

const CODE_PATTERN = /^[A-Za-z0-9_-]+$/;

const couponFields = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, "Give the code at least two characters.")
    .max(40, "Keep the code under 40 characters.")
    .regex(
      CODE_PATTERN,
      "Letters, numbers, hyphens and underscores only — customers have to type this.",
    ),
  type: z.enum(["percent", "fixed"]),
  /** Percent: whole percent. Fixed: paise. The form converts; see header. */
  value: z.number().int().positive("The discount has to be worth something."),
  minOrderPaise: z.number().int().min(0),
  maxDiscountPaise: z.number().int().positive().nullable(),
  usageLimit: z.number().int().positive().nullable(),
  perUserLimit: z.number().int().positive().nullable(),
  audience: z.enum(["everyone", "specific_customers"]),
  /** UTC instants; the form owns the IST conversion. */
  startsAt: z.iso.datetime({ offset: true }).nullable(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  isActive: z.boolean(),
});

const couponRules = [
  {
    check: (data: z.infer<typeof couponFields>) =>
      data.type !== "percent" || data.value <= 100,
    message: "A percent discount cannot exceed 100.",
  },
  {
    check: (data: z.infer<typeof couponFields>) =>
      !data.startsAt ||
      !data.expiresAt ||
      Date.parse(data.expiresAt) > Date.parse(data.startsAt),
    message: "The end has to come after the start.",
  },
] as const;

function withRules<Schema extends typeof couponFields>(schema: Schema) {
  return schema.superRefine((data, context) => {
    for (const rule of couponRules) {
      if (!rule.check(data))
        context.addIssue({ code: "custom", message: rule.message });
    }
  });
}

const couponSchema = withRules(couponFields);

const updateSchema = couponFields
  .extend({ id: z.uuid("That is not a coupon.") })
  .superRefine((data, context) => {
    for (const rule of couponRules) {
      if (!rule.check(data))
        context.addIssue({ code: "custom", message: rule.message });
    }
  });

export async function createCoupon(
  input: unknown,
): Promise<AdminResult<{ id: string }>> {
  return adminAction<{ id: string }>(
    "createCoupon",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = couponSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const { data, error } = await supabase
        .from("coupons")
        .insert(toRow(parsed.data))
        .select("id")
        .single();

      if (error) return writeFailure(error, parsed.data.code);
      bust();
      return { ok: true, id: data.id };
    },
  );
}

export async function updateCoupon(
  input: unknown,
): Promise<AdminResult<{ id: string }>> {
  return adminAction<{ id: string }>(
    "updateCoupon",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = updateSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const { error } = await supabase
        .from("coupons")
        .update(toRow(parsed.data))
        .eq("id", parsed.data.id);

      if (error) return writeFailure(error, parsed.data.code);
      bust();
      return { ok: true, id: parsed.data.id };
    },
  );
}

const activeSchema = z.object({
  id: z.uuid("That is not a coupon."),
  isActive: z.boolean(),
});

export async function setCouponActive(
  input: unknown,
): Promise<AdminResult<{ id: string; isActive: boolean }>> {
  return adminAction<{ id: string; isActive: boolean }>(
    "setCouponActive",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = activeSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const { error } = await supabase
        .from("coupons")
        .update({ is_active: parsed.data.isActive })
        .eq("id", parsed.data.id);
      if (error) return writeFailure(error, null);

      bust();
      return { ok: true, id: parsed.data.id, isActive: parsed.data.isActive };
    },
  );
}

const deleteSchema = z.object({ id: z.uuid("That is not a coupon.") });

export async function deleteCoupon(
  input: unknown,
): Promise<AdminResult<{ id: string }>> {
  return adminAction<{ id: string }>(
    "deleteCoupon",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = deleteSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const { count, error: countError } = await supabase
        .from("coupon_redemptions")
        .select("id", { count: "exact", head: true })
        .eq("coupon_id", parsed.data.id);
      if (countError) return writeFailure(countError, null);

      if ((count ?? 0) > 0) {
        return {
          ok: false,
          reason: "conflict",
          message:
            `This code has been used on ${count} order${count === 1 ? "" : "s"}. ` +
            "Deleting it would orphan that history — switch it off instead; " +
            "customers are refused an inactive code exactly as if it never existed.",
        };
      }

      const { error } = await supabase
        .from("coupons")
        .delete()
        .eq("id", parsed.data.id);
      if (error) return writeFailure(error, null);

      bust();
      return { ok: true, id: parsed.data.id };
    },
  );
}

/**
 * Replace a coupon's audience list wholesale. A diff would save a few writes
 * on a list that is at most a handful of people, at the price of a second code
 * path the form has to agree with — the form sends what it shows.
 */
const audienceSchema = z.object({
  couponId: z.uuid("That is not a coupon."),
  userIds: z.array(z.uuid()).max(500, "That is too many people for one code."),
});

export async function setCouponCustomers(
  input: unknown,
): Promise<AdminResult<{ couponId: string }>> {
  return adminAction<{ couponId: string }>(
    "setCouponCustomers",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = audienceSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const { error: clearError } = await supabase
        .from("coupon_customers")
        .delete()
        .eq("coupon_id", parsed.data.couponId);
      if (clearError) return writeFailure(clearError, null);

      if (parsed.data.userIds.length) {
        const { error } = await supabase.from("coupon_customers").insert(
          parsed.data.userIds.map((userId) => ({
            coupon_id: parsed.data.couponId,
            user_id: userId,
          })),
        );
        if (error) return writeFailure(error, null);
      }

      bust();
      return { ok: true, couponId: parsed.data.couponId };
    },
  );
}

/**
 * The audience picker's search. Same sources as the customers screen — name
 * and phone from `profiles`, email through the customer's own orders — bounded
 * and admin-gated like every other read that leaves this panel.
 */
const findSchema = z.object({ q: z.string().trim().min(2).max(80) });

export async function findCustomersForCoupon(
  input: unknown,
): Promise<
  AdminResult<{
    customers: { userId: string; name: string | null; email: string | null }[];
  }>
> {
  return adminAction(
    "findCustomersForCoupon",
    "adminMutation",
    async ({ supabase }) => {
      const parsed = findSchema.safeParse(input);
      if (!parsed.success) return invalid(parsed.error);

      const pattern = likePattern(parsed.data.q);

      const emailMatches = await rows<{ user_id: string | null }>(
        "admin.coupons.customerSearch.email",
        supabase
          .from("orders")
          .select("user_id")
          .ilike("contact_email", pattern)
          .not("user_id", "is", null)
          .limit(50),
      );
      const emailIds = [
        ...new Set(emailMatches.map((row) => row.user_id).filter(Boolean)),
      ] as string[];

      const clauses = [`full_name.ilike.${pattern}`, `phone.ilike.${pattern}`];
      // Uuids straight out of Postgres; they cannot break the filter syntax.
      if (emailIds.length) clauses.push(`id.in.(${emailIds.join(",")})`);

      const profiles = await rows<{ id: string; full_name: string | null }>(
        "admin.coupons.customerSearch",
        supabase
          .from("profiles")
          .select("id, full_name")
          .eq("role", "customer")
          .or(clauses.join(","))
          .limit(20),
      );

      const ids = profiles.map((profile) => profile.id);
      const emails = ids.length
        ? await rows<{ user_id: string | null; contact_email: string | null }>(
            "admin.coupons.customerSearch.emails",
            supabase
              .from("orders")
              .select("user_id, contact_email, placed_at")
              .in("user_id", ids)
              .order("placed_at", { ascending: false }),
          )
        : [];
      const emailByUser = new Map<string, string>();
      for (const order of emails) {
        if (
          order.user_id &&
          order.contact_email &&
          !emailByUser.has(order.user_id)
        )
          emailByUser.set(order.user_id, order.contact_email);
      }

      return {
        ok: true,
        customers: profiles.map((profile) => ({
          userId: profile.id,
          name: profile.full_name,
          email: emailByUser.get(profile.id) ?? null,
        })),
      };
    },
  );
}

/* -------------------------------------------------------------------------- */
/* helpers — not exported, so no browser can reach them                       */
/* -------------------------------------------------------------------------- */

function toRow(data: z.infer<typeof couponSchema>) {
  return {
    code: data.code,
    type: data.type,
    value: data.value,
    min_order_value: data.minOrderPaise,
    max_discount: data.maxDiscountPaise,
    usage_limit: data.usageLimit,
    per_user_limit: data.perUserLimit,
    audience: data.audience,
    starts_at: data.startsAt,
    expires_at: data.expiresAt,
    is_active: data.isActive,
  };
}

function invalid(error: z.ZodError): AdminResult<never> {
  const issue = error.issues[0];
  return {
    ok: false,
    reason: "invalid",
    message: issue?.message ?? "Check that and try again.",
    field: issue?.path[0] === undefined ? undefined : String(issue.path[0]),
  };
}

function writeFailure(
  error: { code?: string; message: string },
  code: string | null,
): AdminResult<never> {
  if (error.code === "23505") {
    return {
      ok: false,
      reason: "conflict",
      message: code
        ? `Another coupon already uses "${code}". Codes have to be unique.`
        : "Another coupon already uses that code.",
    };
  }
  console.error("[admin] coupon write failed:", error.message, error.code);
  return {
    ok: false,
    reason: "error",
    message: "That did not save. Nothing has been changed — please try again.",
  };
}

function bust() {
  revalidatePath("/admin/coupons");
}
