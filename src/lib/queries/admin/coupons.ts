import "server-only";

import {
  likePattern,
  rangeFor,
  type ListParams,
} from "@/lib/admin/list-params";
import { maybeRow, pagedRows, rows } from "@/lib/queries/run";
import { createClient } from "@/lib/supabase/server";

/**
 * The coupons screen's reads, through the RLS client: the "admins manage
 * coupons" policies are what let these queries see anything, so a session that
 * is not an admin reads an empty table rather than a secret one.
 */

export const COUPON_SORTS = ["code", "created_at", "expires_at"] as const;
export type CouponSort = (typeof COUPON_SORTS)[number];

export type AdminCouponRow = {
  id: string;
  code: string;
  type: "percent" | "fixed";
  value: number;
  minOrderValue: number;
  maxDiscount: number | null;
  usageLimit: number | null;
  usedCount: number;
  perUserLimit: number | null;
  audience: "everyone" | "specific_customers";
  startsAt: string | null;
  expiresAt: string | null;
  isActive: boolean;
  createdAt: string;
};

export type CouponFilter = "" | "active" | "inactive" | "scheduled" | "expired";

export type AdminCouponListRow = AdminCouponRow & {
  /** All-time ledger rows, released included — what blocks a delete. */
  redemptionCount: number;
  /** The audience list, preloaded so the row's edit dialog cannot wipe it. */
  audienceMembers: { userId: string; name: string | null; email: string | null }[];
};

export async function listCoupons(
  params: ListParams<CouponSort>,
  filter: CouponFilter,
): Promise<{ rows: AdminCouponListRow[]; total: number }> {
  const supabase = await createClient();
  const [from, to] = rangeFor(params);

  let query = supabase
    .from("coupons")
    .select(
      "id, code, type, value, min_order_value, max_discount, usage_limit, used_count, per_user_limit, audience, starts_at, expires_at, is_active, created_at",
      { count: "exact" },
    );

  const nowIso = new Date().toISOString();
  if (filter === "active") query = query.eq("is_active", true);
  if (filter === "inactive") query = query.eq("is_active", false);
  if (filter === "scheduled") query = query.gt("starts_at", nowIso);
  if (filter === "expired") query = query.lt("expires_at", nowIso);

  if (params.q) query = query.ilike("code", likePattern(params.q));

  const result = await pagedRows<{
    id: string;
    code: string;
    type: "percent" | "fixed";
    value: number;
    min_order_value: number;
    max_discount: number | null;
    usage_limit: number | null;
    used_count: number;
    per_user_limit: number | null;
    // `text` with a CHECK in the database; narrowed in the mapper.
    audience: string;
    starts_at: string | null;
    expires_at: string | null;
    is_active: boolean;
    created_at: string;
  }>(
    "admin.coupons.list",
    query
      .order(params.sort, { ascending: params.dir === "asc" })
      .order("code", { ascending: true })
      .range(from, to),
  );

  /**
   * Ledger counts and audience lists for the page's rows, one query each —
   * the same shape as the brands list's product counts. The audience rides
   * along because the row's edit dialog *replaces* the membership on save;
   * a dialog opened without it would silently empty the list.
   */
  const ids = result.rows.map((row) => row.id);
  const [ledger, memberships] = ids.length
    ? await Promise.all([
        rows<{ coupon_id: string }>(
          "admin.coupons.redemptionCounts",
          supabase
            .from("coupon_redemptions")
            .select("coupon_id")
            .in("coupon_id", ids),
        ),
        rows<{
          coupon_id: string;
          user_id: string;
          profile: { full_name: string | null } | null;
        }>(
          "admin.coupons.pageAudiences",
          supabase
            .from("coupon_customers")
            .select("coupon_id, user_id, profile:profiles ( full_name )")
            .in("coupon_id", ids)
            .overrideTypes<
              {
                coupon_id: string;
                user_id: string;
                profile: { full_name: string | null } | null;
              }[]
            >(),
        ),
      ])
    : [[], []];

  const counts = new Map<string, number>();
  for (const entry of ledger)
    counts.set(entry.coupon_id, (counts.get(entry.coupon_id) ?? 0) + 1);

  const audiences = new Map<
    string,
    { userId: string; name: string | null; email: string | null }[]
  >();
  for (const membership of memberships) {
    const list = audiences.get(membership.coupon_id) ?? [];
    list.push({
      userId: membership.user_id,
      name: membership.profile?.full_name ?? null,
      email: null,
    });
    audiences.set(membership.coupon_id, list);
  }

  return {
    total: result.total,
    rows: result.rows.map((row) => ({
      id: row.id,
      code: row.code,
      type: row.type,
      value: row.value,
      minOrderValue: row.min_order_value,
      maxDiscount: row.max_discount,
      usageLimit: row.usage_limit,
      usedCount: row.used_count,
      perUserLimit: row.per_user_limit,
      audience: row.audience as AdminCouponRow["audience"],
      startsAt: row.starts_at,
      expiresAt: row.expires_at,
      isActive: row.is_active,
      createdAt: row.created_at,
      redemptionCount: counts.get(row.id) ?? 0,
      audienceMembers: audiences.get(row.id) ?? [],
    })),
  };
}

export type CouponCustomer = {
  userId: string;
  name: string | null;
  phone: string | null;
  /** From their most recent order — profiles has no email column. */
  email: string | null;
};

export type CouponRedemption = {
  id: string;
  orderId: string;
  orderNumber: string | null;
  userId: string | null;
  customerName: string | null;
  code: string;
  discountPaise: number;
  redeemedAt: string;
  releasedAt: string | null;
};

export type AdminCouponDetail = AdminCouponRow & {
  customers: CouponCustomer[];
  redemptions: CouponRedemption[];
};

export async function getCoupon(id: string): Promise<AdminCouponDetail | null> {
  const supabase = await createClient();

  const coupon = await maybeRow<{
    id: string;
    code: string;
    type: "percent" | "fixed";
    value: number;
    min_order_value: number;
    max_discount: number | null;
    usage_limit: number | null;
    used_count: number;
    per_user_limit: number | null;
    // `text` with a CHECK in the database; narrowed in the mapper.
    audience: string;
    starts_at: string | null;
    expires_at: string | null;
    is_active: boolean;
    created_at: string;
  }>(
    "admin.coupons.get",
    supabase
      .from("coupons")
      .select(
        "id, code, type, value, min_order_value, max_discount, usage_limit, used_count, per_user_limit, audience, starts_at, expires_at, is_active, created_at",
      )
      .eq("id", id)
      .maybeSingle(),
  );
  if (!coupon) return null;

  const [members, redemptions] = await Promise.all([
    rows<{
      user_id: string;
      profile: { full_name: string | null; phone: string | null } | null;
    }>(
      "admin.coupons.customers",
      supabase
        .from("coupon_customers")
        .select("user_id, profile:profiles ( full_name, phone )")
        .eq("coupon_id", id)
        .overrideTypes<
          {
            user_id: string;
            profile: { full_name: string | null; phone: string | null } | null;
          }[]
        >(),
    ),
    rows<{
      id: string;
      order_id: string;
      user_id: string | null;
      code: string;
      discount_paise: number;
      redeemed_at: string;
      released_at: string | null;
      order: { order_number: string } | null;
      profile: { full_name: string | null } | null;
    }>(
      "admin.coupons.redemptions",
      supabase
        .from("coupon_redemptions")
        .select(
          "id, order_id, user_id, code, discount_paise, redeemed_at, released_at, order:orders ( order_number ), profile:profiles ( full_name )",
        )
        .eq("coupon_id", id)
        .order("redeemed_at", { ascending: false })
        .limit(200)
        .overrideTypes<
          {
            id: string;
            order_id: string;
            user_id: string | null;
            code: string;
            discount_paise: number;
            redeemed_at: string;
            released_at: string | null;
            order: { order_number: string } | null;
            profile: { full_name: string | null } | null;
          }[]
        >(),
    ),
  ]);

  /**
   * Emails via each member's most recent order, the same source and caveat as
   * the customers screen: an audience member who has never ordered has no
   * email here, and the row says so.
   */
  const memberIds = members.map((member) => member.user_id);
  const memberOrders = memberIds.length
    ? await rows<{ user_id: string | null; contact_email: string | null; placed_at: string }>(
        "admin.coupons.memberEmails",
        supabase
          .from("orders")
          .select("user_id, contact_email, placed_at")
          .in("user_id", memberIds)
          .order("placed_at", { ascending: false }),
      )
    : [];
  const emailByUser = new Map<string, string>();
  for (const order of memberOrders) {
    if (order.user_id && order.contact_email && !emailByUser.has(order.user_id))
      emailByUser.set(order.user_id, order.contact_email);
  }

  return {
    id: coupon.id,
    code: coupon.code,
    type: coupon.type,
    value: coupon.value,
    minOrderValue: coupon.min_order_value,
    maxDiscount: coupon.max_discount,
    usageLimit: coupon.usage_limit,
    usedCount: coupon.used_count,
    perUserLimit: coupon.per_user_limit,
    audience: coupon.audience as AdminCouponRow["audience"],
    startsAt: coupon.starts_at,
    expiresAt: coupon.expires_at,
    isActive: coupon.is_active,
    createdAt: coupon.created_at,
    customers: members.map((member) => ({
      userId: member.user_id,
      name: member.profile?.full_name ?? null,
      phone: member.profile?.phone ?? null,
      email: emailByUser.get(member.user_id) ?? null,
    })),
    redemptions: redemptions.map((redemption) => ({
      id: redemption.id,
      orderId: redemption.order_id,
      orderNumber: redemption.order?.order_number ?? null,
      userId: redemption.user_id,
      customerName: redemption.profile?.full_name ?? null,
      code: redemption.code,
      discountPaise: redemption.discount_paise,
      redeemedAt: redemption.redeemed_at,
      releasedAt: redemption.released_at,
    })),
  };
}
