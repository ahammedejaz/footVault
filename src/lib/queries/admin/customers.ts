import "server-only";

import {
  likePattern,
  rangeFor,
  type ListParams,
} from "@/lib/admin/list-params";
import { pagedRows, rows } from "@/lib/queries/run";
import { createClient } from "@/lib/supabase/server";

/**
 * Who has bought what — and nothing else.
 *
 * This screen is the panel's only view of personal data, so what it *does not*
 * read is the design. There is no address, no order contents, no auth column,
 * no avatar, and no write path anywhere in this file or its page: the question
 * it answers is "who is this and what did they buy", and every field below is
 * one of the two halves of that question. Anything more would be data the owner
 * did not need, sitting on a screen a shop tablet leaves unlocked.
 *
 * **Where the email comes from, and why it is not `auth.users`.** `profiles`
 * has no email column; the address lives in the auth schema, which PostgREST
 * does not expose and which therefore needs the service-role client — leaving
 * the RLS safety net, for a read, on the one screen where a mistake is a
 * personal-data leak rather than a wrong number. So the email shown is the one
 * the customer actually gave at checkout, read from their own orders under the
 * "admins read every order" policy. It has the property that matters more than
 * completeness: it is the same string `/admin/orders?q=…` searches, so the link
 * out of every row is correct by construction rather than by coincidence.
 *
 * The cost is honest and visible — somebody who registered and never ordered
 * has no email here, and the row says so.
 */

/**
 * Sortable columns are the ones Postgres can actually order.
 *
 * Order count, spend and last-order are aggregates over a second table.
 * PostgREST cannot order by an aggregate over an embed, and sorting them in
 * this file would sort *the current page* — which produces a table that looks
 * sorted, is not, and is wrong in a way the owner cannot see. A view or an RPC
 * would fix it properly; adding one is a migration, and this phase does not own
 * the schema. So those three columns are shown and not offered as sorts.
 */
export const CUSTOMER_SORTS = ["full_name", "created_at"] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];

/** Bounds the `id.in.(…)` list a search by email builds. */
const EMAIL_MATCH_CAP = 200;

/**
 * Statuses that did not end in money. A cancelled order is not spend, and
 * counting it makes the owner's best-customer list wrong in the direction that
 * costs them a discount.
 */
const NON_SPEND = new Set(["cancelled", "returned"]);

export type AdminCustomerRow = {
  id: string;
  name: string | null;
  /** From their most recent order. Null when they have never ordered. */
  email: string | null;
  phone: string | null;
  orderCount: number;
  /** Paise, excluding cancelled and returned orders. */
  lifetimeValue: number;
  lastOrderAt: string | null;
  joinedAt: string;
};

export async function listCustomers(
  params: ListParams<CustomerSort>,
): Promise<{ rows: AdminCustomerRow[]; total: number }> {
  const supabase = await createClient();
  const [from, to] = rangeFor(params);

  let query = supabase
    .from("profiles")
    // Admins are excluded rather than badged. The owner is not their own
    // customer, and a role column on a customer list is an auth field on a
    // screen that has deliberately not got any.
    .select(`id, full_name, phone, created_at`, { count: "exact" })
    .eq("role", "customer");

  if (params.q) {
    const pattern = likePattern(params.q);
    const clauses = [`full_name.ilike.${pattern}`, `phone.ilike.${pattern}`];

    /**
     * Email search in two steps rather than one.
     *
     * The email is on `orders`, the row is on `profiles`, and PostgREST cannot
     * `or` across an embed. Resolving the matching user ids first keeps the
     * paging server-side — the alternative, reading every profile and filtering
     * here, would make page two of a search meaningless.
     */
    const matches = await rows<{ user_id: string | null }>(
      "admin.customers.emailSearch",
      supabase
        .from("orders")
        .select("user_id")
        .ilike("contact_email", pattern)
        .not("user_id", "is", null)
        .limit(EMAIL_MATCH_CAP),
    );
    const ids = [
      ...new Set(matches.map((row) => row.user_id).filter(Boolean)),
    ] as string[];
    // Safe to interpolate: these are uuids straight out of Postgres, so they
    // cannot carry the comma or bracket that would break the filter's syntax.
    if (ids.length) clauses.push(`id.in.(${ids.join(",")})`);

    query = query.or(clauses.join(","));
  }

  const result = await pagedRows<{
    id: string;
    full_name: string | null;
    phone: string | null;
    created_at: string;
  }>(
    "admin.customers.list",
    query
      .order(params.sort, {
        ascending: params.dir === "asc",
        nullsFirst: false,
      })
      .order("created_at", { ascending: false })
      .range(from, to),
  );

  const ids = result.rows.map((row) => row.id);
  const orders = ids.length
    ? await rows<{
        user_id: string | null;
        grand_total: number;
        placed_at: string;
        contact_email: string | null;
        status: string;
      }>(
        "admin.customers.orderTotals",
        supabase
          .from("orders")
          .select("user_id, grand_total, placed_at, contact_email, status")
          .in("user_id", ids),
      )
    : [];

  type Tally = {
    count: number;
    spend: number;
    lastAt: string | null;
    email: string | null;
  };
  const tally = new Map<string, Tally>();
  for (const order of orders) {
    const key = order.user_id;
    if (!key) continue;
    const current = tally.get(key) ?? {
      count: 0,
      spend: 0,
      lastAt: null,
      email: null,
    };
    current.count += 1;
    if (!NON_SPEND.has(order.status)) current.spend += order.grand_total;
    if (current.lastAt === null || order.placed_at > current.lastAt) {
      current.lastAt = order.placed_at;
      // Deliberately follows the most recent order rather than the first: an
      // address the customer has since changed is the wrong one to telephone.
      if (order.contact_email) current.email = order.contact_email;
    }
    if (current.email === null && order.contact_email) {
      current.email = order.contact_email;
    }
    tally.set(key, current);
  }

  return {
    total: result.total,
    rows: result.rows.map((row) => {
      const totals = tally.get(row.id);
      return {
        id: row.id,
        name: row.full_name,
        email: totals?.email ?? null,
        phone: row.phone,
        orderCount: totals?.count ?? 0,
        lifetimeValue: totals?.spend ?? 0,
        lastOrderAt: totals?.lastAt ?? null,
        joinedAt: row.created_at,
      };
    }),
  };
}
