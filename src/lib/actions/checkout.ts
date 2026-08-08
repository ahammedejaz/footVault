"use server";

import { revalidatePath } from "next/cache";

import { saveAddress as saveAddressToBook } from "@/lib/actions/address";
import { getCurrentUser } from "@/lib/auth";
import { readGuestToken } from "@/lib/cart/token";
import { sendOrderConfirmation } from "@/lib/email";
import {
  CHECKOUT_SQLSTATE,
  describeOutOfStock,
  parseOutOfStockItems,
} from "@/lib/orders/errors";
import type {
  OrderStatus,
  PaymentStatus,
  PlaceOrderInput,
  PlaceOrderResult,
  ShippingAddress,
} from "@/lib/orders/types";
import { getPaymentAdapter, isPaymentMethodAvailable } from "@/lib/payments";
import {
  assertPaise,
  type PaymentInitiation,
  type PaymentMethod,
} from "@/lib/payments/types";
import { callerIdentity, consumeRateLimit } from "@/lib/rate-limit";
import { computeOrderTotals } from "@/lib/orders/totals";
import { getCart } from "@/lib/queries/cart";
import { maybeRow } from "@/lib/queries/run";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { checkoutSchema } from "@/lib/validations/checkout";

/**
 * Placing an order.
 *
 * This action is the single authority. Read `PlaceOrderInput` in
 * `src/lib/orders/types.ts` and note what the browser is not allowed to say: no
 * prices, no lines, no quantities, no totals, not even a cart id. The bag is
 * resolved from the caller's own session under RLS, and every rupee is
 * recomputed inside `create_order_with_stock` under a row lock. There is no
 * number in the money path that came from a client.
 *
 * `getCart()` is used, but only as a hint. It is a render-time read with no
 * lock: between it and the transaction, stock can vanish and a price can
 * change. Its job here is to answer "is there anything to check out" and to
 * supply the lines for the confirmation email — never to decide a total. The
 * totals returned to the caller are the ones the database computed.
 *
 * **The order comes first, then the payment.** The row exists and its stock is
 * already claimed before the Razorpay modal opens, which is what makes the
 * modal safe: a customer who pays is paying for units nobody else can take. The
 * cost is that a provider we cannot reach leaves an order nobody will pay for,
 * so that path rolls the order back, restocks, hands the bag back, and says so
 * in words that leave no doubt the customer was not charged.
 */

/**
 * Delivery pricing no longer lives here.
 *
 * `site_settings.shipping` used to be read at this point and passed to
 * `create_order_with_stock` as a flat fee plus a threshold. Since the fee now
 * depends on the destination and the payment method, that decision moved
 * wholesale into `computeOrderTotals` — the one function every surface calls,
 * which reads the answer from `shipping_quotes`, the same row the checkout page
 * showed the customer. Two places computing a price is two prices, and this
 * codebase had three.
 */

const GENERIC =
  "We could not place your order. Nothing has been charged. Please try again.";

export async function placeOrder(
  input: PlaceOrderInput,
): Promise<PlaceOrderResult> {
  try {
    const user = await getCurrentUser();

    // The server decides who is signed in, so the "is an email required" rule
    // is a parameter of the schema rather than a field in the payload.
    const parsed = checkoutSchema({ requireContactEmail: !user }).safeParse(
      input,
    );
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        reason: "invalid_input",
        message: issue?.message ?? "Check the details and try again.",
        field: issue?.path[0] === undefined ? undefined : String(issue.path[0]),
      };
    }
    const data = parsed.data;
    const method: PaymentMethod = data.paymentMethod;

    // Asked before an order exists. A customer who picks a method that cannot
    // work should be told now, not after their stock has been claimed.
    if (!isPaymentMethodAvailable(method)) {
      return {
        ok: false,
        reason: "payment_unavailable",
        message:
          "That payment method is not available right now. Choose another.",
      };
    }

    /**
     * Placed before the first database read, so a caller in a loop is stopped
     * before they cost us a cart query, a settings read and a write transaction
     * that takes a row lock on every variant in the bag.
     *
     * Counted per signed-in customer, or per IP for a guest. Not per guest
     * token: that is a cookie the caller holds, and a limiter you can reset by
     * clearing a cookie is decoration.
     *
     * Ten a minute. A customer who is genuinely retrying a failed card sits far
     * under it; a script trying to exhaust stock by placing and abandoning
     * orders sits far over. The abandoned-order sweep already gives that stock
     * back after thirty minutes, so this narrows a window rather than closing a
     * hole — E-1 was the hole and it is fixed.
     */
    const throttle = await consumeRateLimit(
      "checkout",
      await callerIdentity(user?.id ?? null),
    );
    if (!throttle.allowed) {
      return {
        ok: false,
        reason: "throttled",
        retryAfterSeconds: throttle.retryAfterSeconds,
        message:
          "That is a lot of attempts in a short time. Wait a moment and try again — " +
          "nothing has been placed and nothing has been charged.",
      };
    }

    const cart = await getCart();
    if (!cart.id || cart.lines.length === 0) {
      return {
        ok: false,
        reason: "empty_cart",
        message: "Your bag is empty. Add something before checking out.",
      };
    }

    // Minted long before now — a bag cannot exist without one — so this reads
    // rather than creates. A guest with no token has no cart to check out.
    const guestToken = user ? null : await readGuestToken();
    if (!user && !guestToken) {
      return {
        ok: false,
        reason: "empty_cart",
        message: "Your bag is empty. Add something before checking out.",
      };
    }

    const address = await resolveAddress(
      user?.id ?? null,
      data.addressId,
      data.address,
    );
    if (!address) {
      return {
        ok: false,
        reason: "invalid_input",
        message: "Add a delivery address.",
        field: "address",
      };
    }

    /**
     * One quote decides three things: whether we can deliver at all, whether
     * cash can be collected, and what the customer pays to receive it.
     *
     * **It is read from `shipping_quotes`, not taken fresh.** The checkout page
     * already asked for this exact combination — same bag, same postcode, same
     * method — and showed the customer the answer. Quoting again here could
     * return a different number, and charging a figure the customer was never
     * shown is the one failure this whole path exists to prevent. If the stored
     * quote has lapsed, `chargeableFee` takes a new one, which is honest: a
     * fifteen-minute-old price is not a promise.
     *
     * **The browser still sends no money.** It sent a postcode and a method.
     * Every rupee below is computed on this server and recomputed inside
     * `create_order_with_stock`, so `PlaceOrderInput` remains a type with no
     * number in it.
     */
    const units = cart.lines.reduce((total, line) => total + line.quantity, 0);
    const totals = await computeOrderTotals({
      cartId: cart.id,
      postalCode: address.postalCode,
      method,
      subtotalPaise: cart.subtotal,
      units,
    });

    /**
     * A pin code no courier will reach is refused outright, for every payment
     * method.
     *
     * This is the owner's decision and it is the honest one: taking money for a
     * parcel that cannot be sent buys a refund, a support conversation and a
     * disappointed customer. Note that `deliverable` is false *only* when
     * Shiprocket says so in as many words — an outage, a timeout or an
     * ambiguous empty response all leave it true, so a courier problem still
     * cannot block a sale.
     */
    if (!totals.deliverable) {
      return {
        ok: false,
        reason: "undeliverable",
        message:
          `We are sorry — no courier will carry to ${address.postalCode} from our store. ` +
          "Try a different delivery address, or contact us and we will see what we can do.",
      };
    }

    /**
     * Cash on delivery, only where cash can actually be collected.
     *
     * The hook Phase 5 §8.8 left for exactly this. Fails soft in the same
     * direction as everything else: only an explicit "couriers serve this pin
     * code and none of them will collect cash" declines.
     */
    if (method === "cod" && !totals.codAvailable) {
      return {
        ok: false,
        reason: "payment_unavailable",
        message:
          `No courier will collect cash at ${address.postalCode}. ` +
          "Pay online instead and we will send it to the same address.",
      };
    }

    /**
     * **Nothing is confirmed before money moves — for either method.**
     *
     * Pay on Delivery used to be written `confirmed` the moment it was placed,
     * on the reasoning that there was nothing to wait for. There is now: the
     * advance. An order that committed stock against a promise is exactly what
     * this phase removes, so both methods start `pending` and the webhook is
     * the only thing allowed to confirm either of them. That also means the
     * existing abandoned-order sweep covers Pay on Delivery for free — a
     * customer who dismisses the modal releases their stock in thirty minutes
     * rather than holding it forever.
     */
    const initialStatus: OrderStatus = "pending";
    const paymentStatus: PaymentStatus = "unpaid";

    const admin = createAdminClient();
    const { data: created, error } = await admin.rpc(
      "create_order_with_stock",
      {
        p_cart_id: cart.id,
        p_shipping_address: address,
        p_payment_method: method,
        p_initial_status: initialStatus,
        p_payment_status: paymentStatus,
        // The quote has already applied the free-delivery threshold, the COD
        // rule and the rounding, so the fee is passed as-is and the function is
        // told there is no threshold left to apply. Passing both would let the
        // database silently zero a COD fee that deliberately has no free tier.
        p_shipping_flat_fee: totals.shippingFee,
        p_free_shipping_above: null,
        // The advance is passed; the balance is *derived* inside the function
        // as grand_total - advance. Two independently-supplied numbers would
        // break the check constraint the moment a price moved under the row
        // lock, and take the checkout down with an opaque error.
        p_advance_amount: totals.advanceAmount,
        p_cod_handling_fee: totals.codHandlingFee,
        p_user_id: user?.id,
        p_guest_token: guestToken ?? undefined,
        p_contact_email: data.contactEmail ?? user?.email ?? undefined,
        p_contact_phone: data.contactPhone ?? address.phone,
        p_customer_note: data.customerNote ?? undefined,
      },
    );

    if (error) {
      if (error.code === CHECKOUT_SQLSTATE.outOfStock) {
        const items = parseOutOfStockItems(error.details);
        return {
          ok: false,
          reason: "out_of_stock",
          message: describeOutOfStock(items),
          items,
        };
      }
      if (error.code === CHECKOUT_SQLSTATE.emptyCart) {
        return {
          ok: false,
          reason: "empty_cart",
          message: "Your bag is empty.",
        };
      }
      if (error.code === CHECKOUT_SQLSTATE.cartUnavailable) {
        // Almost always a double submit: the first one won and converted the
        // cart. Saying "already placed" is truer than "something went wrong".
        return {
          ok: false,
          reason: "error",
          message:
            "This bag has already been checked out. Look in your orders before trying again.",
        };
      }
      console.error(
        "[checkout] create_order_with_stock failed:",
        error.message,
        error.code,
      );
      return { ok: false, reason: "error", message: GENERIC };
    }

    const order = created?.[0];
    if (!order) {
      console.error("[checkout] create_order_with_stock returned no row");
      return { ok: false, reason: "error", message: GENERIC };
    }

    const grandTotal = assertPaise("checkout.grandTotal", order.grand_total);

    /**
     * **What is charged online is the advance, not the total.**
     *
     * Read back from the row the database wrote rather than reused from
     * `totals`, because the function recomputed the subtotal under a row lock
     * and clamped the advance into it. For a prepaid order the two are the same
     * number; for Pay on Delivery this is the whole point of the feature, and
     * charging `grandTotal` here would take the goods value online and then ask
     * the courier to collect it a second time.
     */
    const advance = assertPaise("checkout.advance", order.advance_amount);
    const balanceDue = assertPaise("checkout.balanceDue", order.balance_due);

    // Best-effort, and after the order exists rather than before: a book that
    // fails to save must not cost somebody their checkout.
    if (data.saveAddress && user) {
      const saved = await saveAddressToBook({
        ...address,
        label: null,
        isDefault: false,
      });
      if (!saved.ok)
        console.warn(
          "[checkout] could not save the address to the book:",
          saved.message,
        );
    }

    const initiation = await initiatePayment({
      method,
      orderId: order.order_id,
      orderNumber: order.order_number,
      amountPaise: advance,
      name: address.recipientName,
      email: data.contactEmail ?? user?.email ?? null,
      phone: data.contactPhone ?? address.phone,
    });

    if (!initiation) {
      await rollBackUnpaidOrder(order.order_id, "Payment could not be started");
      revalidatePath("/", "layout");
      return {
        ok: false,
        reason: "payment_init_failed",
        message:
          "We could not reach the payment provider, so your order was cancelled and nothing " +
          "was charged. Your bag is exactly as you left it — please try again.",
      };
    }

    if (initiation.kind === "razorpay") {
      const recorded = await recordProviderOrder(
        order.order_id,
        initiation,
        advance,
      );
      if (!recorded) {
        // Without this row the webhook cannot find the order, so a captured
        // payment would never confirm anything. Better to refuse now.
        await rollBackUnpaidOrder(
          order.order_id,
          "Could not record the payment attempt",
        );
        revalidatePath("/", "layout");
        return {
          ok: false,
          reason: "payment_init_failed",
          message:
            "We could not start the payment safely, so your order was cancelled and nothing " +
            "was charged. Your bag is exactly as you left it — please try again.",
        };
      }
    }

    await confirmByEmail({
      orderNumber: order.order_number,
      to: data.contactEmail ?? user?.email ?? null,
      customerName: address.recipientName,
      method,
      lines: cart.lines.map((line) => ({
        productName: line.productName,
        size: line.size,
        quantity: line.quantity,
        lineTotal: line.lineTotal,
      })),
      subtotal: order.subtotal,
      shippingFee: order.shipping_fee,
      codHandlingFee: totals.codHandlingFee,
      grandTotal,
      advanceAmount: advance,
      balanceDueOnDelivery: balanceDue,
      address,
    });

    // The bag is converted, so the header badge and the cart page are both
    // stale everywhere on the site.
    revalidatePath("/", "layout");

    return {
      ok: true,
      order: {
        id: order.order_id,
        orderNumber: order.order_number,
        grandTotal,
        paymentMethod: method,
        status: initialStatus,
        paymentStatus,
        initiation,
      },
    };
  } catch (thrown) {
    console.error("[checkout] placeOrder threw:", thrown);
    return { ok: false, reason: "error", message: GENERIC };
  }
}

/**
 * Give up on an order that was never paid for.
 *
 * The "customer closed the Razorpay modal" case. Nothing else frees the stock a
 * pending order is holding — a failed payment deliberately does not cancel,
 * because Razorpay lets the customer retry the same order and cancelling would
 * hand their units to somebody else.
 *
 * Ownership is proved by reading the order through the RLS client first, so a
 * forged order number finds nothing rather than somebody else's order. The
 * cancellation itself then runs through the service role, because a customer
 * has no UPDATE policy on `orders` and should not.
 */
export async function abandonUnpaidOrder(input: {
  orderNumber: string;
}): Promise<{ ok: boolean; message: string }> {
  try {
    const user = await getCurrentUser();

    // Registered and reachable from a browser as of Phase 6, so it is now a
    // public entry point to a cancellation path and gets counted like one. RLS
    // decides *whether* the caller may cancel; this only decides how fast they
    // may ask.
    const throttle = await consumeRateLimit(
      "orderCancel",
      await callerIdentity(user?.id ?? null),
    );
    if (!throttle.allowed) {
      return {
        ok: false,
        message: "Too many attempts. Wait a moment and try again.",
      };
    }

    const supabase = await createClient();
    const own = await maybeRow<{ id: string; status: OrderStatus }>(
      "abandonUnpaidOrder.own",
      supabase
        .from("orders")
        .select("id, status")
        .eq("order_number", input.orderNumber.trim())
        .maybeSingle(),
    );
    if (!own) return { ok: false, message: "We could not find that order." };
    if (own.status !== "pending") {
      return {
        ok: false,
        message: "That order can no longer be cancelled here.",
      };
    }

    const outcome = await cancelWithRestock(
      own.id,
      "Payment abandoned by the customer",
      true,
      user?.id ?? null,
    );
    if (outcome === "cancelled" || outcome === "already_cancelled") {
      revalidatePath("/", "layout");
      return {
        ok: true,
        message: "Your order was cancelled and nothing was charged.",
      };
    }
    if (outcome === "already_paid") {
      return {
        ok: false,
        message: "That payment went through. Contact us if you need to cancel.",
      };
    }
    return {
      ok: false,
      message: "We could not cancel that order. Please contact us.",
    };
  } catch (thrown) {
    console.error("[checkout] abandonUnpaidOrder threw:", thrown);
    return {
      ok: false,
      message: "We could not cancel that order. Please contact us.",
    };
  }
}

/* ------------------------------------------------------------------ parts -- */

/**
 * Where it is going.
 *
 * An `addressId` is read back through the RLS client, so a book entry belonging
 * to somebody else simply does not exist for this caller — the ownership check
 * is the policy, not a `user_id` comparison in this file. Guests never take
 * this path: they have no book, and the schema makes `address` the only way
 * they can supply one.
 */
async function resolveAddress(
  userId: string | null,
  addressId: string | undefined,
  typed: ShippingAddress | undefined,
): Promise<ShippingAddress | null> {
  if (addressId && userId) {
    const supabase = await createClient();
    const saved = await maybeRow<{
      recipient_name: string;
      phone: string;
      line1: string;
      line2: string | null;
      city: string;
      state: string;
      postal_code: string;
    }>(
      "checkout.savedAddress",
      supabase
        .from("addresses")
        .select("recipient_name, phone, line1, line2, city, state, postal_code")
        .eq("id", addressId)
        .maybeSingle(),
    );
    if (saved) {
      return {
        recipientName: saved.recipient_name,
        phone: saved.phone,
        line1: saved.line1,
        line2: saved.line2,
        city: saved.city,
        state: saved.state,
        postalCode: saved.postal_code,
        country: "IN",
      };
    }
  }
  return typed ?? null;
}

/**
 * Ask the provider for whatever the browser needs next.
 *
 * Returns null on anything that is not a usable initiation, including a
 * Razorpay result with a missing key or order id — a modal opened with half its
 * arguments fails in front of the customer instead of here, where we can still
 * undo the order cleanly.
 */
async function initiatePayment(args: {
  method: PaymentMethod;
  orderId: string;
  orderNumber: string;
  amountPaise: number;
  name: string;
  email: string | null;
  phone: string | null;
}): Promise<PaymentInitiation | null> {
  try {
    const initiation = await getPaymentAdapter(args.method).initiate({
      orderId: args.orderId,
      orderNumber: args.orderNumber,
      amountPaise: args.amountPaise,
      customer: { name: args.name, email: args.email, phone: args.phone },
    });

    if (initiation.kind === "razorpay") {
      if (!initiation.providerOrderId || !initiation.keyId) return null;
      if (initiation.amountPaise !== args.amountPaise) {
        console.error(
          "[checkout] the provider was given a different amount than the order holds",
        );
        return null;
      }
    }
    return initiation;
  } catch (thrown) {
    // Never the provider's error text: it can carry account detail, and the
    // customer is being told one thing only, which is that they were not
    // charged.
    console.error("[checkout] payment initiation failed:", thrown);
    return null;
  }
}

/**
 * The row a webhook resolves an order from.
 *
 * Written here rather than in the adapter, because `src/lib/payments/` may not
 * read or write orders — `payments` is order data. It has to exist before the
 * modal opens: Razorpay can deliver `payment.captured` before the browser
 * callback returns, and without this row that event has no order to apply to.
 */
async function recordProviderOrder(
  orderId: string,
  initiation: Extract<PaymentInitiation, { kind: "razorpay" }>,
  amountPaise: number,
): Promise<boolean> {
  const admin = createAdminClient();
  const { error } = await admin.from("payments").insert({
    order_id: orderId,
    provider: "razorpay",
    provider_order_id: initiation.providerOrderId,
    amount: amountPaise,
    currency: initiation.currency,
    status: "created",
  });
  if (error) {
    console.error(
      "[checkout] could not record the payment attempt:",
      error.message,
      error.code,
    );
    return false;
  }
  return true;
}

/**
 * Cancel, restock, and hand the bag back. Returns the function's verdict.
 *
 * `actor` is passed through to `inventory_movements.actor` so the ledger can say
 * *who* put the stock back. It is null for the rollback path, which is the
 * server undoing its own failed initiation rather than a person deciding
 * anything, and null is the honest answer to "who did this".
 */
async function cancelWithRestock(
  orderId: string,
  reason: string,
  releaseCart: boolean,
  actor: string | null = null,
): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("cancel_order_with_restock", {
    p_order_id: orderId,
    p_reason: reason,
    p_require_unpaid: true,
    p_release_cart: releaseCart,
    p_changed_by: actor ?? undefined,
  });
  if (error) {
    console.error(
      "[checkout] cancel_order_with_restock failed:",
      error.message,
      error.code,
    );
    return "error";
  }
  return data ?? "error";
}

/**
 * Undo an order the customer never got the chance to pay for.
 *
 * Loud on failure, because the failure mode is silent and expensive: stock
 * claimed by an order nobody will ever pay for, which nothing else will notice.
 */
async function rollBackUnpaidOrder(
  orderId: string,
  reason: string,
): Promise<void> {
  const outcome = await cancelWithRestock(orderId, reason, true);
  if (outcome !== "cancelled" && outcome !== "already_cancelled") {
    console.error(
      `[checkout] could not roll back order ${orderId} after a failed initiation: ${outcome}. ` +
        "Its stock is still claimed and needs releasing by hand.",
    );
  }
}

/** Never allowed to matter. See src/lib/email/index.ts. */
async function confirmByEmail(args: {
  orderNumber: string;
  to: string | null;
  customerName: string;
  method: PaymentMethod;
  lines: {
    productName: string;
    size: string;
    quantity: number;
    lineTotal: number;
  }[];
  subtotal: number;
  shippingFee: number;
  codHandlingFee: number;
  grandTotal: number;
  advanceAmount: number;
  balanceDueOnDelivery: number;
  address: ShippingAddress;
}): Promise<void> {
  if (!args.to) {
    // Only possible for a signed-in customer with no email on their claims,
    // which OAuth and password sign-up both rule out. Worth a line if it ever
    // happens rather than a silent skip.
    console.warn(
      `[checkout] order ${args.orderNumber} has no address to confirm to`,
    );
    return;
  }

  await sendOrderConfirmation({
    orderNumber: args.orderNumber,
    to: args.to,
    customerName: args.customerName,
    paymentMethod: args.method,
    lines: args.lines,
    totals: {
      subtotal: args.subtotal,
      discountTotal: 0,
      shippingFee: args.shippingFee,
      codHandlingFee: args.codHandlingFee,
      taxTotal: 0,
      grandTotal: args.grandTotal,
      advanceAmount: args.advanceAmount,
      balanceDueOnDelivery: args.balanceDueOnDelivery,
    },
    shippingAddress: args.address,
  });
}
