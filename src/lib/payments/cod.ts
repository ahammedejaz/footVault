import "server-only";

import { razorpayAdapter } from "@/lib/payments/razorpay";
import type {
  ClientCallbackClaim,
  InitiateContext,
  PaymentAdapter,
  PaymentInitiation,
  VerificationResult,
  WebhookParseResult,
} from "@/lib/payments/types";

/**
 * Pay on Delivery.
 *
 * **This is no longer a method with no provider.** It used to be: `initiate()`
 * returned `kind: "none"`, the order was written `confirmed` with nothing paid,
 * and `verifyClientCallback` failed closed because there was nothing to verify.
 * Order FV-2026-00488 is one of those — `confirmed`, `unpaid`, ₹1,719 of stock
 * committed against a promise.
 *
 * The model now: the customer pays an **advance** through Razorpay at checkout
 * and the courier collects the **balance** in cash. So every payment in this
 * shop goes through one provider, and this adapter delegates all four of its
 * money-moving methods to `razorpayAdapter` rather than reimplementing them.
 * That is the whole design: there is no second payment path to keep in step,
 * and every guarantee Phase 5 built — idempotency, webhook-as-truth,
 * compare-and-swap on status, the unique constraint on `razorpay_order_id`,
 * timing-safe signature comparison — applies to a Pay-on-Delivery order without
 * a line of new code.
 *
 * What stays distinct is the *commercial* meaning: `orders.payment_method` is
 * still `cod`, because what separates these orders is not who processes the
 * card but whether a courier is collecting cash at the door. The amount handed
 * to `initiate()` is the advance, decided by `computeOrderTotals` from the
 * owner's `cod_advance` rule; this adapter neither knows nor needs to know
 * which portion of the order it is charging.
 *
 * **`server-only` now, where it deliberately was not before.** The old file
 * avoided it so a render path could import the copy without crossing the server
 * boundary. Reaching Razorpay means reaching a key secret one import away, so
 * that trade no longer holds. Nothing outside `./index.ts` imports this file,
 * and `PaymentMethodCopy` lives in `./types` for anything that needs the words.
 */
export const codAdapter: PaymentAdapter = {
  method: "cod",

  /**
   * The honest words.
   *
   * **"Cash on Delivery" is gone**, and the rename is not cosmetic: money is due
   * before the parcel moves, and a label promising otherwise is the single most
   * misleading string this site could carry. The brief is explicit — never show
   * a bare "COD" label with no advance disclosed.
   *
   * The exact rupee figures are deliberately absent here. They depend on the
   * bag and the destination — the advance for a ₹1,499 order to one PIN is not
   * the advance for a ₹17,000 order to another — so the checkout UI renders
   * "Pay ₹X now…" from the computed totals. Static copy claiming a specific
   * amount would be wrong for most orders, which is worse than general.
   */
  copy: {
    method: "cod",
    label: "Pay on Delivery",
    description:
      "Pay the delivery charge now to confirm your order. Pay the rest in cash when it arrives.",
    note: "Please have the exact amount ready. Our couriers cannot always give change.",
  },

  /**
   * Available exactly when Razorpay is, because the advance is a Razorpay
   * payment. A shop with no keys configured cannot take Pay on Delivery either
   * — and offering it would strand the customer at a modal that cannot open.
   *
   * The other two gates live elsewhere and both are per-order rather than per
   * method: `site_settings.shipping.cod_enabled` is the owner's master switch,
   * and Shiprocket's serviceability answers whether a courier will collect cash
   * at that particular PIN. `computeOrderTotals` folds both into `codAvailable`.
   */
  isAvailable(): boolean {
    return razorpayAdapter.isAvailable();
  },

  /** The advance, not the order total. The caller decides which number that is. */
  async initiate(context: InitiateContext): Promise<PaymentInitiation> {
    return razorpayAdapter.initiate(context);
  },

  async verifyClientCallback(
    claim: ClientCallbackClaim,
  ): Promise<VerificationResult> {
    return razorpayAdapter.verifyClientCallback(claim);
  },

  parseWebhook(
    rawBody: string,
    signatureHeader: string | null,
  ): WebhookParseResult {
    return razorpayAdapter.parseWebhook(rawBody, signatureHeader);
  },
};
