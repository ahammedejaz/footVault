import "server-only";

import { getCurrentUser } from "@/lib/auth";
import { maybeRow, rows } from "@/lib/queries/run";
import { createClient } from "@/lib/supabase/server";
import { isPaymentMethod, type PaymentMethod } from "@/lib/payments/types";
import type {
  OrderLine,
  OrderStatus,
  OrderSummary,
  OrderTimelineEntry,
  OrderView,
  PaymentStatus,
  ShippingAddress,
} from "@/lib/orders/types";

/**
 * Reading an order.
 *
 * **Ownership is decided by the database, not by this file.** Both reads go
 * through the RLS client, so a signed-in customer sees rows where
 * `user_id = auth.uid()` and a guest sees rows where `guest_token` matches the
 * x-guest-token header their browser is carrying. A `null` from
 * getOrderForViewer is therefore not "no such order" — it is "not yours, or no
 * such order", and the two are indistinguishable on purpose: telling a stranger
 * that FV-2026-00042 exists but is not theirs is telling them something.
 *
 * That is also why nothing here filters on the order number alone. Order
 * numbers come from a sequence and are guessable by construction; the policy
 * keys on identity and the number is only a lookup key within what the caller
 * can already see.
 *
 * Every rupee rendered from these came out of `order_items`' snapshot columns.
 * Nothing re-reads the catalog — an order shows what was bought at the price it
 * was bought for, whatever has happened to the product since.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RawItem = {
  id: string;
  product_name: string;
  product_slug: string | null;
  size: string;
  color: string;
  sku: string;
  unit_price: number;
  quantity: number;
  line_total: number;
  image_url: string | null;
};

type RawHistory = {
  status: OrderStatus;
  note: string | null;
  created_at: string;
  changed_by: string | null;
};

type RawOrder = {
  id: string;
  order_number: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  payment_method: string;
  placed_at: string;
  subtotal: number;
  discount_total: number;
  shipping_fee: number;
  tax_total: number;
  grand_total: number;
  cod_handling_fee: number;
  advance_amount: number;
  balance_due_on_delivery: number;
  shipping_address: unknown;
  contact_email: string | null;
  contact_phone: string | null;
  customer_note: string | null;
  user_id: string | null;
  items: RawItem[];
  history: RawHistory[];
};

/**
 * The jsonb snapshot, read back.
 *
 * Coerced field by field rather than cast, because the column is `jsonb` and a
 * cast is a promise the compiler cannot keep. It was validated by
 * `shippingAddressSchema` on the way in, so this is about surviving a row
 * written before that schema existed rather than about distrusting the writer —
 * and an order page that throws because an old address has no `line2` helps
 * nobody.
 */
function toShippingAddress(value: unknown): ShippingAddress {
  const raw = (
    typeof value === "object" && value !== null ? value : {}
  ) as Record<string, unknown>;
  const str = (key: string) =>
    typeof raw[key] === "string" ? (raw[key] as string) : "";
  return {
    recipientName: str("recipientName"),
    phone: str("phone"),
    line1: str("line1"),
    line2:
      typeof raw.line2 === "string" && raw.line2.length > 0 ? raw.line2 : null,
    city: str("city"),
    state: str("state"),
    postalCode: str("postalCode"),
    country: "IN",
  };
}

/** Stored as text so a new method needs no migration; narrowed on the way out. */
function toPaymentMethod(value: string): PaymentMethod {
  return isPaymentMethod(value) ? value : "cod";
}

/**
 * Who made this happen, in a word the customer understands.
 *
 * A null `changed_by` is the system — the checkout transaction, or a webhook —
 * and reads as "Foot Vault". Anyone else is staff, and staff resolve to "Foot
 * Vault" too: a customer has no read on `profiles` other than their own, so we
 * could not name them without an elevated query, and naming the individual who
 * packed a box is not information the customer asked for.
 */
function actorFor(changedBy: string | null, viewerId: string | null): string {
  if (changedBy && viewerId && changedBy === viewerId) return "You";
  return "Foot Vault";
}

function toLines(items: RawItem[]): OrderLine[] {
  return (
    [...items]
      // The insert-select does not preserve the bag's order, and every row shares
      // a created_at, so sort on something a human would recognise instead.
      .sort(
        (a, b) =>
          a.product_name.localeCompare(b.product_name) ||
          a.size.localeCompare(b.size),
      )
      .map((item) => ({
        id: item.id,
        productName: item.product_name,
        productSlug: item.product_slug,
        size: item.size,
        color: item.color,
        sku: item.sku,
        unitPrice: item.unit_price,
        quantity: item.quantity,
        lineTotal: item.line_total,
        imageUrl: item.image_url,
      }))
  );
}

function toTimeline(
  history: RawHistory[],
  viewerId: string | null,
): OrderTimelineEntry[] {
  return [...history]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((row) => ({
      status: row.status,
      note: row.note,
      at: row.created_at,
      by: actorFor(row.changed_by, viewerId),
    }));
}

export async function getOrderForViewer(
  orderNumberOrId: string,
): Promise<OrderView | null> {
  const key = orderNumberOrId.trim();
  if (!key) return null;

  const user = await getCurrentUser();
  const supabase = await createClient();

  const query = supabase.from("orders").select(
    `id, order_number, status, payment_status, payment_method, placed_at,
       subtotal, discount_total, shipping_fee, tax_total, grand_total,
       cod_handling_fee, advance_amount, balance_due_on_delivery,
       shipping_address, contact_email, contact_phone, customer_note, user_id,
       items:order_items (
         id, product_name, product_slug, size, color, sku,
         unit_price, quantity, line_total, image_url
       ),
       history:order_status_history ( status, note, created_at, changed_by )`,
  );

  const scoped = UUID.test(key)
    ? query.eq("id", key)
    : query.eq("order_number", key);

  const row = await maybeRow<RawOrder>(
    `getOrderForViewer(${key})`,
    scoped.maybeSingle().overrideTypes<RawOrder>(),
  );
  if (!row) return null;

  return {
    id: row.id,
    orderNumber: row.order_number,
    status: row.status,
    paymentStatus: row.payment_status,
    paymentMethod: toPaymentMethod(row.payment_method),
    placedAt: row.placed_at,
    totals: {
      subtotal: row.subtotal,
      discountTotal: row.discount_total,
      shippingFee: row.shipping_fee,
      codHandlingFee: row.cod_handling_fee,
      taxTotal: row.tax_total,
      grandTotal: row.grand_total,
      advanceAmount: row.advance_amount,
      balanceDueOnDelivery: row.balance_due_on_delivery,
    },
    lines: toLines(row.items ?? []),
    shippingAddress: toShippingAddress(row.shipping_address),
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    customerNote: row.customer_note,
    timeline: toTimeline(row.history ?? [], user?.id ?? null),
    isGuestOrder: row.user_id === null,
  };
}

/**
 * The account's order list.
 *
 * Signed-in only, and it says so by returning nothing rather than by throwing:
 * a guest has orders but no list, because there is no durable identity to list
 * them under — their one order is reachable from the confirmation page and the
 * token in their cookie, which is exactly as much as a guest checkout promises.
 *
 * Bounded at fifty. Nobody has scrolled past fifty orders on a shoe shop, and
 * an unbounded list is a query that gets slower for the best customers.
 */
export async function listOrdersForCustomer(): Promise<OrderSummary[]> {
  const user = await getCurrentUser();
  if (!user) return [];

  const supabase = await createClient();

  type RawSummary = {
    id: string;
    order_number: string;
    status: OrderStatus;
    payment_status: PaymentStatus;
    placed_at: string;
    grand_total: number;
    items: {
      quantity: number;
      image_url: string | null;
      product_name: string;
    }[];
  };

  const raw = await rows<RawSummary>(
    "listOrdersForCustomer",
    supabase
      .from("orders")
      .select(
        `id, order_number, status, payment_status, placed_at, grand_total,
         items:order_items ( quantity, image_url, product_name )`,
      )
      .eq("user_id", user.id)
      .order("placed_at", { ascending: false })
      .limit(50)
      .overrideTypes<RawSummary[]>(),
  );

  return raw.map((order) => ({
    id: order.id,
    orderNumber: order.order_number,
    status: order.status,
    paymentStatus: order.payment_status,
    placedAt: order.placed_at,
    grandTotal: order.grand_total,
    itemCount: (order.items ?? []).reduce(
      (total, item) => total + item.quantity,
      0,
    ),
    thumbnails: (order.items ?? [])
      .slice(0, 3)
      .map((item) => ({ url: item.image_url, alt: item.product_name })),
  }));
}
