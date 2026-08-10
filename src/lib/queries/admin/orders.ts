import "server-only";

import type { OrderStatus, PaymentStatus } from "@/lib/orders/types";
import {
  likePattern,
  rangeFor,
  type ListParams,
} from "@/lib/admin/list-params";
import { maybeRow, pagedRows, rows } from "@/lib/queries/run";
import {
  getShipment,
  getShipmentError,
  type ShipmentErrorRow,
  type ShipmentRow,
} from "@/lib/shipping/fulfilment";
import { createClient } from "@/lib/supabase/server";

/** Columns the orders table may be ordered by. Allow-listed; see list-params. */
export const ORDER_SORTS = [
  "placed_at",
  "order_number",
  "grand_total",
  "status",
] as const;
export type OrderSort = (typeof ORDER_SORTS)[number];

export type AdminOrderRow = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: string;
  grandTotal: number;
  /** Already paid online. Shown on the row so the owner can scan it. */
  advanceAmount: number;
  /** What the courier collects at the door. */
  balanceDueOnDelivery: number;
  placedAt: string;
  recipient: string;
  contactEmail: string | null;
  contactPhone: string | null;
  itemCount: number;
  awb: string | null;
  courier: string | null;
};

export type OrderFilters = {
  status: OrderStatus | "";
  from: string;
  to: string;
};

export async function listOrders(
  params: ListParams<OrderSort>,
  filters: OrderFilters,
): Promise<{ rows: AdminOrderRow[]; total: number }> {
  const supabase = await createClient();
  const [from, to] = rangeFor(params);

  let query = supabase.from("orders").select(
    // A template literal, not a concatenation. `"a" + "b"` widens to `string`,
    // and supabase-js parses this select at the *type* level to build the row
    // type — given `string` it gives up and returns GenericStringError, which
    // surfaces as an unreadable assignability error a long way from here.
    `id, order_number, status, payment_status, payment_method, grand_total,
       advance_amount, balance_due_on_delivery,
       placed_at, contact_email, contact_phone, shipping_address`,
    { count: "exact" },
  );

  if (filters.status) query = query.eq("status", filters.status);
  if (filters.from) query = query.gte("placed_at", `${filters.from}T00:00:00Z`);
  // Inclusive of the whole end day. `lte` against the bare date would exclude
  // every order placed after midnight on it, which is all of them.
  if (filters.to) query = query.lte("placed_at", `${filters.to}T23:59:59.999Z`);

  /**
   * Search covers order number, phone and email — the three things a customer
   * on the telephone can actually tell you. Names are deliberately not
   * searched: they live inside the `shipping_address` jsonb, and a `->>`
   * comparison there cannot use an index, so it would turn every search into a
   * sequential scan of the orders table to support the least reliable
   * identifier of the three.
   */
  if (params.q) {
    const pattern = likePattern(params.q);
    query = query.or(
      `order_number.ilike.${pattern},contact_phone.ilike.${pattern},contact_email.ilike.${pattern}`,
    );
  }

  const result = await pagedRows<{
    id: string;
    order_number: string;
    status: OrderStatus;
    payment_status: PaymentStatus;
    payment_method: string;
    grand_total: number;
    advance_amount: number;
    balance_due_on_delivery: number;
    placed_at: string;
    contact_email: string | null;
    contact_phone: string | null;
    shipping_address: unknown;
  }>(
    "admin.orders.list",
    query
      .order(params.sort, { ascending: params.dir === "asc" })
      .range(from, to),
  );

  /**
   * Line counts and AWBs come as two follow-up queries rather than as PostgREST
   * embeds on the query above.
   *
   * It is not an N+1 — both are one round trip scoped to the twenty-five ids
   * already in hand, so a page costs three queries whatever its size. The
   * embedded form (`order_items(count), shipments(…)`) is one query and reads
   * better, and it is what this started as; it does not survive the generated
   * types, which resolve a reverse embed on a freshly added relation to
   * `GenericStringError`. Given the choice between three legible queries and a
   * cast that silences the type checker on the shape of a result, three queries.
   */
  const ids = result.rows.map((row) => row.id);
  const [lines, shipments] = await Promise.all([
    ids.length
      ? rows<{ order_id: string }>(
          "admin.orders.lineCounts",
          supabase.from("order_items").select("order_id").in("order_id", ids),
        )
      : Promise.resolve([]),
    ids.length
      ? rows<{
          order_id: string;
          awb_code: string | null;
          courier_name: string | null;
        }>(
          "admin.orders.shipments",
          supabase
            .from("shipments")
            .select("order_id, awb_code, courier_name")
            .in("order_id", ids),
        )
      : Promise.resolve([]),
  ]);

  const lineCount = new Map<string, number>();
  for (const line of lines)
    lineCount.set(line.order_id, (lineCount.get(line.order_id) ?? 0) + 1);
  const shipmentByOrder = new Map(shipments.map((row) => [row.order_id, row]));

  return {
    total: result.total,
    rows: result.rows.map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      status: row.status,
      paymentStatus: row.payment_status,
      paymentMethod: row.payment_method,
      grandTotal: row.grand_total,
      advanceAmount: row.advance_amount,
      balanceDueOnDelivery: row.balance_due_on_delivery,
      placedAt: row.placed_at,
      recipient: addressField(row.shipping_address, "recipientName") ?? "—",
      contactEmail: row.contact_email,
      contactPhone: row.contact_phone,
      itemCount: lineCount.get(row.id) ?? 0,
      awb: shipmentByOrder.get(row.id)?.awb_code ?? null,
      courier: shipmentByOrder.get(row.id)?.courier_name ?? null,
    })),
  };
}

export type AdminOrderDetail = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: string;
  subtotal: number;
  shippingFee: number;
  /** The forward leg alone, named — render sites never subtract. */
  forwardShippingFee: number;
  discountTotal: number;
  /** The part of it given for paying online. */
  prepaidDiscount: number;
  /** The coupon's own figure, from its own column — never derived. */
  couponDiscount: number;
  grandTotal: number;
  /** The Pay-on-Delivery extra, as its own line. 0 for prepaid. */
  codHandlingFee: number;
  /** Already paid online. */
  advanceAmount: number;
  /** What the courier is collecting. The owner needs this at a glance. */
  balanceDueOnDelivery: number;
  cashCollectedAt: string | null;
  deliveredAt: string | null;
  placedAt: string;
  customerNote: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  userId: string | null;
  isGuest: boolean;
  stockRestoredAt: string | null;
  address: {
    recipientName: string;
    phone: string;
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  items: {
    id: string;
    productId: string | null;
    productName: string;
    productSlug: string | null;
    size: string;
    color: string;
    sku: string;
    unitPrice: number;
    quantity: number;
    lineTotal: number;
    imageUrl: string | null;
  }[];
  history: {
    id: string;
    status: OrderStatus;
    note: string | null;
    createdAt: string;
  }[];
  payments: {
    id: string;
    provider: string;
    status: string;
    amount: number;
    providerPaymentId: string | null;
    providerOrderId: string | null;
    createdAt: string;
  }[];
};

export async function getOrderDetail(
  orderId: string,
): Promise<AdminOrderDetail | null> {
  const supabase = await createClient();

  const order = await maybeRow<{
    id: string;
    order_number: string;
    status: OrderStatus;
    payment_status: PaymentStatus;
    payment_method: string;
    subtotal: number;
    shipping_fee: number;
    discount_total: number;
    prepaid_discount: number;
    coupon_discount: number;
    grand_total: number;
    cod_handling_fee: number;
    advance_amount: number;
    balance_due_on_delivery: number;
    cash_collected_at: string | null;
    delivered_at: string | null;
    placed_at: string;
    customer_note: string | null;
    contact_email: string | null;
    contact_phone: string | null;
    user_id: string | null;
    guest_token: string | null;
    stock_restored_at: string | null;
    shipping_address: unknown;
  }>(
    "admin.orders.detail",
    supabase
      .from("orders")
      .select(
        `id, order_number, status, payment_status, payment_method, subtotal, shipping_fee,
         discount_total, prepaid_discount, coupon_discount, grand_total, cod_handling_fee, advance_amount,
         balance_due_on_delivery, cash_collected_at, delivered_at,
         placed_at, customer_note, contact_email, contact_phone,
         user_id, guest_token, stock_restored_at, shipping_address`,
      )
      .eq("id", orderId)
      .maybeSingle(),
  );

  // Null means "no such order" *or* "not readable by this caller", and the two
  // are indistinguishable on purpose — the same rule the storefront's order
  // page follows.
  if (!order) return null;

  const [items, history, payments] = await Promise.all([
    rows<{
      id: string;
      product_id: string | null;
      product_name: string;
      product_slug: string | null;
      size: string;
      color: string;
      sku: string;
      unit_price: number;
      quantity: number;
      line_total: number;
      image_url: string | null;
    }>(
      "admin.orders.items",
      supabase
        .from("order_items")
        .select(
          `id, product_id, product_name, product_slug, size, color, sku,
           unit_price, quantity, line_total, image_url`,
        )
        .eq("order_id", orderId)
        .order("created_at", { ascending: true }),
    ),
    rows<{
      id: string;
      status: OrderStatus;
      note: string | null;
      created_at: string;
    }>(
      "admin.orders.history",
      supabase
        .from("order_status_history")
        .select("id, status, note, created_at")
        .eq("order_id", orderId)
        .order("created_at", { ascending: true }),
    ),
    rows<{
      id: string;
      provider: string;
      status: string;
      amount: number;
      provider_payment_id: string | null;
      provider_order_id: string | null;
      created_at: string;
    }>(
      "admin.orders.payments",
      supabase
        .from("payments")
        .select(
          `id, provider, status, amount, provider_payment_id, provider_order_id, created_at`,
        )
        .eq("order_id", orderId)
        .order("created_at", { ascending: true }),
    ),
  ]);

  return {
    id: order.id,
    orderNumber: order.order_number,
    status: order.status,
    paymentStatus: order.payment_status,
    paymentMethod: order.payment_method,
    subtotal: order.subtotal,
    shippingFee: order.shipping_fee,
    forwardShippingFee: order.shipping_fee - order.cod_handling_fee,
    discountTotal: order.discount_total,
    prepaidDiscount: order.prepaid_discount,
    couponDiscount: order.coupon_discount,
    grandTotal: order.grand_total,
    codHandlingFee: order.cod_handling_fee,
    advanceAmount: order.advance_amount,
    balanceDueOnDelivery: order.balance_due_on_delivery,
    cashCollectedAt: order.cash_collected_at,
    deliveredAt: order.delivered_at,
    placedAt: order.placed_at,
    customerNote: order.customer_note,
    contactEmail: order.contact_email,
    contactPhone: order.contact_phone,
    userId: order.user_id,
    isGuest: order.user_id === null,
    stockRestoredAt: order.stock_restored_at,
    address: {
      recipientName:
        addressField(order.shipping_address, "recipientName") ?? "—",
      phone: addressField(order.shipping_address, "phone") ?? "—",
      line1: addressField(order.shipping_address, "line1") ?? "—",
      line2: addressField(order.shipping_address, "line2"),
      city: addressField(order.shipping_address, "city") ?? "—",
      state: addressField(order.shipping_address, "state") ?? "—",
      postalCode: addressField(order.shipping_address, "postalCode") ?? "—",
      country: addressField(order.shipping_address, "country") ?? "IN",
    },
    items: items.map((item) => ({
      id: item.id,
      productId: item.product_id,
      productName: item.product_name,
      productSlug: item.product_slug,
      size: item.size,
      color: item.color,
      sku: item.sku,
      unitPrice: item.unit_price,
      quantity: item.quantity,
      lineTotal: item.line_total,
      imageUrl: item.image_url,
    })),
    history: history.map((row) => ({
      id: row.id,
      status: row.status,
      note: row.note,
      createdAt: row.created_at,
    })),
    payments: payments.map((row) => ({
      id: row.id,
      provider: row.provider,
      status: row.status,
      amount: row.amount,
      providerPaymentId: row.provider_payment_id,
      providerOrderId: row.provider_order_id,
      createdAt: row.created_at,
    })),
  };
}

/**
 * One field out of an order's address snapshot.
 *
 * The column is `jsonb` and typed as `Json`, so every read of it is a narrowing
 * rather than a cast. An order written before a field existed simply has no
 * value for it, and that has to render as a dash rather than throw on a page
 * the owner opened to fulfil something.
 */
function addressField(address: unknown, key: string): string | null {
  if (address && typeof address === "object" && key in address) {
    const value = (address as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/**
 * The shipment for an order, or null before one has been created.
 *
 * Read through the caller's own RLS client rather than the service role: an
 * admin reading is still a read, and the shipments policies already say who may
 * see one. `getShipment` in `src/lib/shipping/fulfilment.ts` is the single
 * definition of that query, so the fulfilment steps and this page can never
 * disagree about what a shipment is.
 */
export async function getOrderShipment(
  orderId: string,
): Promise<ShipmentRow | null> {
  return getShipment(await createClient(), orderId);
}

/**
 * Why the last fulfilment step failed, or null when nothing is wrong.
 *
 * A separate read rather than a join, and a separate table rather than columns
 * on `shipments` — see `20260809120000_shipment_errors.sql`. It is one row by
 * primary key on an order the page has already loaded, and it has to be its own
 * read because the failure that matters most is the one where the shipments row
 * was deleted and there is nothing to join to.
 *
 * Through the caller's own RLS client, like everything else on this page. The
 * table's only policy is `is_admin()`, so a customer reading their own order
 * cannot reach it — deliberately: these messages are about the shop's Shiprocket
 * account rather than about their parcel.
 */
export async function getOrderShipmentError(
  orderId: string,
): Promise<ShipmentErrorRow | null> {
  return getShipmentError(await createClient(), orderId);
}
