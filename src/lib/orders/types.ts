import type { Database } from "@/lib/database.types";
import type { PaymentMethod } from "@/lib/payments/types";

/**
 * The order domain, as everything outside `src/lib/orders/` sees it.
 *
 * Two things live here and nowhere else: the **state machine**, because a
 * transition rule that exists in three files is three rules; and the
 * **signatures** of checkout, because the checkout UI, the payment webhook and
 * the account pages all have to agree about them before any of the three is
 * written.
 *
 * No server dependency, for the same structural reason as `cart-types.ts` and
 * `payments/types.ts`. See the comment at the top of `src/lib/cart-types.ts`.
 *
 * Money is integer paise throughout. There is no float in this file.
 */

export type OrderStatus = Database["public"]["Enums"]["order_status"];
export type PaymentStatus = Database["public"]["Enums"]["payment_status"];

/* --------------------------------------------------------- state machine -- */

/**
 * Which transitions are legal.
 *
 * Written as data rather than as a `switch`, so `docs/architecture.md` can
 * render the same thing the code enforces and the two cannot drift. An empty
 * array is a terminal state.
 *
 *   pending ──▶ confirmed ──▶ packed ──▶ shipped ──▶ delivered ──▶ returned
 *      │            │            │           │
 *      └────────────┴────────────┴───────────┴──────▶ cancelled
 *
 * `pending` means the order row exists and stock is already claimed — it is
 * written in the same transaction as the decrement — but money has not been
 * settled. A COD order is `confirmed` the moment it is placed, because there is
 * nothing to wait for. A Razorpay order stays `pending` until the webhook says
 * captured, which is the only thing allowed to confirm it.
 *
 * Nothing transitions *out of* `delivered` except `returned`, and nothing
 * transitions out of `cancelled` or `returned` at all. An order that needs to
 * come back from either is a new order or an admin correction with an audit
 * row, not a status edit.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["packed", "cancelled"],
  packed: ["shipped", "cancelled"],
  shipped: ["delivered", "cancelled"],
  delivered: ["returned"],
  cancelled: [],
  returned: [],
} as const;

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = ["cancelled", "returned"];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function isTerminalStatus(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

/**
 * What happens to stock when an order leaves the flow.
 *
 * Stock is decremented **at order creation**, in the same transaction as the
 * order write, so a placed order has already claimed its units. Cancelling
 * therefore has to give them back, or the shop slowly leaks inventory to
 * abandoned Razorpay modals.
 *
 * `returned` deliberately does **not** restock. A returned pair has to be
 * inspected before it can be sold again, and an automatic restock would put a
 * damaged shoe back on the shelf. Phase 8 owns returns properly; until then the
 * owner adjusts the count by hand and the reason is written down here rather
 * than discovered.
 */
export const RESTOCKS_ON_ENTRY: Readonly<Record<OrderStatus, boolean>> = {
  pending: false,
  confirmed: false,
  packed: false,
  shipped: false,
  delivered: false,
  cancelled: true,
  returned: false,
} as const;

/* ------------------------------------------------------------- addresses -- */

/**
 * A shipping address, snapshotted onto the order as jsonb.
 *
 * A snapshot rather than a foreign key: a customer tidying their address book
 * must not silently rewrite where a shipped order went. The column is `jsonb`
 * so this shape is the only thing that describes it — keep it in step with
 * `shippingAddressSchema` in `src/lib/validations/checkout.ts`, which is what
 * validates it on the way in.
 */
export type ShippingAddress = {
  recipientName: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: "IN";
};

/* -------------------------------------------------------------- checkout -- */

/**
 * Everything the browser is allowed to say at checkout.
 *
 * Read what is missing. No prices, no line items, no totals, no cart id, no
 * quantities. The server reads the bag for the caller's own session, recomputes
 * every rupee from the catalog, and writes the result; a field here for any of
 * those would be a field an attacker gets to fill in. This type *is* the trust
 * boundary, so adding to it is a security decision, not a convenience one.
 */
export type PlaceOrderInput = {
  paymentMethod: PaymentMethod;
  /** Existing address book entry. Signed-in customers only; ignored for guests. */
  addressId?: string;
  /** A new address, typed at checkout. Required when `addressId` is absent. */
  address?: ShippingAddress;
  /** Required for guests, so there is somewhere to send the confirmation. */
  contactEmail?: string;
  contactPhone?: string;
  customerNote?: string;
  /** Save this address to the book. Signed-in only; a guest has no book. */
  saveAddress?: boolean;
};

/** One thing that went out of stock, named so the customer knows what to drop. */
export type OutOfStockItem = {
  productName: string;
  size: string;
  /** What they asked for versus what is left. `available` may be 0. */
  requested: number;
  available: number;
};

/**
 * The result of trying to place an order.
 *
 * A discriminated union rather than a thrown error, because every one of these
 * needs different words on screen and half of them are not failures of ours.
 * `out_of_stock` carries the items so the page can name them — "something went
 * wrong" after a customer has typed an address is how a bag gets abandoned.
 */
export type PlaceOrderResult =
  | { ok: true; order: PlacedOrder }
  | { ok: false; reason: "empty_cart"; message: string }
  | { ok: false; reason: "out_of_stock"; message: string; items: OutOfStockItem[] }
  | { ok: false; reason: "invalid_input"; message: string; field?: string }
  | { ok: false; reason: "payment_unavailable"; message: string }
  | {
      /**
       * The order exists but the provider could not be reached, so nothing was
       * charged and stock has been given back. Distinct from `error` because
       * the customer must be told, unambiguously, that they were not charged.
       */
      ok: false;
      reason: "payment_init_failed";
      message: string;
    }
  | { ok: false; reason: "error"; message: string };

/**
 * A placed order, as the browser needs it.
 *
 * `initiation` is what the payment step does next — nothing at all for COD, or
 * the handful of publishable values the Razorpay modal needs. The order row
 * already exists by the time this is returned, and its stock is already
 * claimed, which is what makes the modal safe to open.
 */
export type PlacedOrder = {
  id: string;
  orderNumber: string;
  grandTotal: number;
  paymentMethod: PaymentMethod;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  initiation: import("@/lib/payments/types").PaymentInitiation;
};

/* ----------------------------------------------------------- order views -- */

/** One line, as snapshotted. Never re-read from the catalog after the fact. */
export type OrderLine = {
  id: string;
  productName: string;
  productSlug: string | null;
  size: string;
  color: string;
  sku: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  imageUrl: string | null;
};

export type OrderTotals = {
  subtotal: number;
  discountTotal: number;
  shippingFee: number;
  taxTotal: number;
  grandTotal: number;
};

export type OrderTimelineEntry = {
  status: OrderStatus;
  note: string | null;
  at: string;
  /** "You", "Foot Vault", or a staff name. Resolved server-side. */
  by: string;
};

export type OrderView = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod;
  placedAt: string;
  totals: OrderTotals;
  lines: OrderLine[];
  shippingAddress: ShippingAddress;
  contactEmail: string | null;
  contactPhone: string | null;
  customerNote: string | null;
  timeline: OrderTimelineEntry[];
  /** True when this order was placed without an account and still has none. */
  isGuestOrder: boolean;
};

/** The list row on /account/orders. Deliberately cheaper than OrderView. */
export type OrderSummary = {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  placedAt: string;
  grandTotal: number;
  itemCount: number;
  /** Up to three thumbnails, for the list. */
  thumbnails: { url: string | null; alt: string }[];
};

/* -------------------------------------------------- the seam for payments -- */

/**
 * How a verified payment event moves an order.
 *
 * `src/lib/payments/` never writes to `orders`. The webhook route proves the
 * event is genuine, turns it into a `PaymentOutcome`, and hands it here — so
 * every write to order state goes through one module that knows the transition
 * rules, whatever provider produced the event.
 *
 * **Every function below must be safe to call repeatedly with the same
 * `eventId`.** Razorpay retries; a captured event arriving for the fourth time
 * has to be a no-op, not a fourth confirmation and certainly not a fourth stock
 * decrement. The `eventId` is recorded before the transition and checked first.
 */
export type ApplyPaymentResult =
  | { applied: true; status: OrderStatus; paymentStatus: PaymentStatus }
  /** Already processed, or the order is past the point this event describes. */
  | { applied: false; reason: "duplicate" | "not_found" | "illegal_transition"; message: string };
