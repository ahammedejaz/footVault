import "server-only";

import type { OrderTotals } from "@/lib/orders/types";
import type { AdvanceRule, AdvanceSplit } from "@/lib/payments/advance";
import {
  advanceFor,
  advanceForFlat,
  codOfferedForOrder,
  flatModeDepositPaise,
  prepaidDiscountFor,
} from "@/lib/payments/advance";
import type { PaymentMethod } from "@/lib/payments/types";
import { quoteFor } from "@/lib/shipping/quote-store";
import { advanceRule, shippingSettings } from "@/lib/shipping/settings";

/**
 * The one place a total is computed. Everything else reads the answer.
 *
 * The brief asked for this by name, and the reason was a live bug: *"checkout
 * totals now differ between COD and pay-online... make total computation a
 * single shared server-side function that both methods call."* Three places
 * were computing delivery independently — the cart read a flat fee from
 * settings, the product page hardcoded the same two literals, and `placeOrder`
 * charged a live Shiprocket rate. Orders FV-2026-00487 and FV-2026-00488 carry
 * identical ₹1,499 subtotals and different delivery, ₹199 against ₹220, and the
 * checkout page displayed a third number again.
 *
 * The rule this file exists to enforce: **any difference between what two
 * payment methods cost must be a named line item, never an artefact of two code
 * paths that drifted.** There is exactly one such difference — `codHandlingFee`
 * — and it is returned separately so it can be rendered as its own row.
 *
 * **Nothing here trusts the browser.** The subtotal and unit count are resolved
 * from the caller's own cart under RLS by whoever calls this; the postcode is
 * the only customer-supplied input and it only selects a courier rate. A caller
 * who posted their own subtotal could otherwise quote themselves free delivery.
 */

export type CheckoutTotals = OrderTotals & {
  /** False means no courier will carry there — checkout must refuse. */
  deliverable: boolean;
  codAvailable: boolean;
  estimatedDays: number | null;
  courierName: string | null;
  /** How the fee was arrived at. `unavailable` means the customer sees an estimate. */
  basis: "free" | "live" | "flat" | "unavailable";
  /** The pricing mode in force, frozen onto the order beside the quote. */
  rateMode: "live" | "flat";
  /** Which discounts are in force, for the surface that has to name them. */
  discountApplied: "coupon" | "prepaid" | "both" | null;
  /**
   * The stacking ceiling in basis points, for `create_order_with_stock` to
   * re-apply on the subtotal it computes under the row lock. Null when the
   * owner has not set one — the function then refuses a stacked pair rather
   * than inventing a cap.
   */
  maxTotalDiscountBps: number | null;
  /** Why Pay on Delivery is not on offer, when it is not. Null when it is. */
  codWithheldReason:
    | "below_minimum"
    | "settings"
    | "courier"
    | "no_quote"
    | "deposit_unset"
    | null;
  /** The two legs the advance is made of, and the courier both came from. */
  quotedForwardPaise: number | null;
  quotedRtoPaise: number | null;
  quotedCodFeePaise: number | null;
  courierId: number | null;
};

export async function computeOrderTotals(input: {
  cartId: string;
  postalCode: string;
  method: PaymentMethod;
  subtotalPaise: number;
  units: number;
  /** The coupon's candidate discount, already validated and rounded. */
  discountPaise?: number;
  /** Set when this customer has had Pay on Delivery withdrawn. */
  codBlocked?: boolean;
}): Promise<CheckoutTotals> {
  const couponDiscount = input.discountPaise ?? 0;

  const [quote, settings] = await Promise.all([
    quoteFor({
      cartId: input.cartId,
      postalCode: input.postalCode,
      method: input.method,
      subtotalPaise: input.subtotalPaise,
      units: input.units,
    }),
    shippingSettings(),
  ]);

  /**
   * **Prepaid is visibly cheaper, as a line the customer can point at.**
   *
   * Prepaid orders are refused far less often than cash ones, and that is worth
   * money to the shop — so some of it goes back. It is folded into
   * `discountTotal` so `grandTotal` arithmetic is unchanged and every existing
   * read site still works, and returned separately so the payment step can draw
   * it beside the Pay-on-Delivery option, which is the only place a customer can
   * act on it. The owner sets the value; this file only knows it is a line.
   */
  const prepaidCandidate =
    input.method === "cod"
      ? 0
      : prepaidDiscountFor({
          discount: settings.prepaidDiscount,
          goodsTotalPaise: input.subtotalPaise,
        });

  /**
   * **Stacking** (owner's decision, 2026-08-10, reversing the same day's
   * no-stacking rule): the coupon and the prepaid incentive now **combine**,
   * additively — both computed on the original goods subtotal, never on each
   * other — and every surface draws them as two named lines.
   *
   * The combination is capped at `max_total_discount_percent` of the goods
   * total. The coupon keeps its full value first and the prepaid part absorbs
   * the clamp: the coupon is the promise the customer typed in, the prepaid
   * incentive is the shop's own gesture, and of the two only one was ever
   * spelled out to the customer as a number they are owed.
   *
   * **With the ceiling unset, stacking is withheld, loudly** — the customer
   * gets the larger single discount (tie to the coupon, the name they expect
   * on the receipt) and the log says which setting is missing. Unset-and-loud
   * rather than a default, per the owner's standing rule: the number is
   * theirs. `create_order_with_stock` refuses outright if both parts reach it
   * without a ceiling, so this fallback cannot drift from the database's.
   */
  const ceilingPercent = settings.maxTotalDiscountPercent;
  let appliedCoupon = couponDiscount;
  let prepaidDiscount = prepaidCandidate;
  if (couponDiscount > 0 && prepaidCandidate > 0) {
    if (ceilingPercent === null) {
      console.error(
        "[totals] a coupon and the prepaid discount both apply, but " +
          "max_total_discount_percent is unset — stacking withheld, the " +
          "larger discount applied alone. Set the ceiling at /admin/settings.",
      );
      const couponWins = couponDiscount >= prepaidCandidate;
      appliedCoupon = couponWins ? couponDiscount : 0;
      prepaidDiscount = couponWins ? 0 : prepaidCandidate;
    } else {
      // Floor, not round: a ceiling that rounds up is a ceiling that leaks.
      const ceilingPaise = Math.floor(
        (input.subtotalPaise * ceilingPercent) / 100,
      );
      appliedCoupon = Math.min(couponDiscount, ceilingPaise);
      prepaidDiscount = Math.min(
        prepaidCandidate,
        ceilingPaise - appliedCoupon,
      );
    }
  }
  const discountTotal = appliedCoupon + prepaidDiscount;

  /**
   * `shippingFee` is the **total** charged for delivery, and `codHandlingFee`
   * says how much of that total is the Pay-on-Delivery extra — Shiprocket's
   * cash-collection fee, and nothing else since Phase 7 moved the return leg
   * into the advance.
   *
   * Modelled as "total, of which" rather than as two addends on purpose: it
   * keeps `grandTotal` arithmetic identical to what it has always been, and it
   * matches `orders.shipping_fee`, so no read site has to remember to add two
   * columns together.
   */
  const shippingFee = quote.feePaise;
  const codHandlingFee = quote.codHandlingPaise;
  // The one place the forward leg is computed. Render sites read the field;
  // the no-derived-money-line lint rule keeps them that way.
  const forwardShippingFee = shippingFee - codHandlingFee;
  const grandTotal = input.subtotalPaise - discountTotal + shippingFee;

  /**
   * **The advance is the round trip, and it is netted off the balance.**
   *
   * `advance = forward freight + RTO freight`, both from the same courier
   * entry; `balance = goods + delivery − advance`. The customer's total is
   * identical either way and a refused parcel is already paid for. See
   * `src/lib/payments/advance.ts` for the arithmetic and the worked example.
   *
   * Prepaid settles in full online, so its "advance" is the whole order and the
   * courier collects nothing. Expressing it this way rather than with a null
   * means every order answers the same two questions, and the invariant
   * `advance + balance = grand_total` holds for every row without a special
   * case. The database enforces exactly that.
   */
  /**
   * **What secures this order, and the two ways it can be secured.**
   *
   * In live mode the deposit is the round trip the courier quoted. The return
   * leg mirrors the forward one when Shiprocket omits `rto_charges` — that is
   * still courier data doubled, not a settings constant, and a return whose cost
   * is unknown is not a free return.
   *
   * In flat mode there is no round trip, because no call was made. The deposit
   * comes from `flat_cod_deposit_*` instead, and when the owner has not set one
   * this is **null** rather than zero. The owner's instruction was *"never
   * silently collect nothing"*, so a missing rule withdraws the payment method a
   * few lines below instead of taking a deposit of a rupee.
   */
  const flatMode = quote.rateMode === "flat";
  const roundTripPaise =
    flatMode || quote.costForwardPaise === null
      ? null
      : Math.max(0, quote.costForwardPaise) +
        Math.max(0, quote.costRtoPaise ?? quote.costForwardPaise);

  const flatDepositPaise = flatModeDepositPaise({
    rule: settings.flatCodDeposit,
    flatShippingFeePaise: settings.flatShippingFeePaise,
  });

  const split =
    input.method === "cod"
      ? codSplit({
          rule: advanceRule(settings),
          roundTripPaise,
          flatDepositPaise,
          forwardFreightPaise: quote.costForwardPaise,
          rtoFreightPaise: quote.costRtoPaise,
          grandTotalPaise: grandTotal,
        })
      : { advancePaise: grandTotal, balanceDuePaise: 0, cappedBy: null };

  const belowMinimum = !codOfferedForOrder({
    goodsTotalPaise: input.subtotalPaise,
    minimumOrderValuePaise: settings.codMinimumOrderValuePaise,
  });

  /**
   * Five reasons Pay on Delivery may not be offered, kept apart because they
   * need different words on the payment step.
   *
   * "The shop has turned it off", "your basket is under the minimum" and "no
   * courier here collects cash" are three different things to tell a customer,
   * and only one of them is something they can act on. Batch 2 added two more,
   * neither of which is the customer's fault either.
   *
   * The cascade is `codWithheldFor` below rather than an expression here,
   * because it is the API half of the owner's Pay-on-Delivery toggle and it is
   * the only thing between a cash order and an unsecured one. Inline, it was
   * reachable only by building a cart, a quote and a settings row — which in
   * practice means it was reachable only in production. `npm run audit:delivery`
   * walks every branch and sweeps every input combination.
   */
  const codWithheldReason = codWithheldFor({
    codEnabled: settings.codEnabled,
    codBlocked: input.codBlocked === true,
    belowMinimum,
    flatMode,
    roundTripPaise,
    flatDepositPaise,
    fallbackBehaviour: settings.fallbackBehaviour,
    courierTakesCash: quote.codAvailable,
  });

  return {
    subtotal: input.subtotalPaise,
    discountTotal,
    shippingFee,
    forwardShippingFee,
    codHandlingFee,
    taxTotal: 0,
    grandTotal,
    advanceAmount: split.advancePaise,
    balanceDueOnDelivery: split.balanceDuePaise,
    deliverable: quote.deliverable,
    codAvailable: codWithheldReason === null,
    codWithheldReason,
    prepaidDiscount,
    couponDiscount: appliedCoupon,
    maxTotalDiscountBps:
      ceilingPercent === null ? null : Math.round(ceilingPercent * 100),
    discountApplied:
      appliedCoupon > 0 && prepaidDiscount > 0
        ? "both"
        : appliedCoupon > 0
          ? "coupon"
          : prepaidDiscount > 0
            ? "prepaid"
            : null,
    estimatedDays: quote.estimatedDays,
    courierName: quote.courierName,
    courierId: quote.courierId,
    quotedForwardPaise: quote.costForwardPaise,
    quotedRtoPaise: quote.costRtoPaise,
    quotedCodFeePaise: quote.codHandlingPaise,
    basis: quote.basis,
    rateMode: quote.rateMode,
  };
}

/**
 * The Pay-on-Delivery split, from whichever deposit secures this order.
 *
 * Separated from `computeOrderTotals` so the one rule that must never bend is
 * readable on its own: **there is no path through this function that collects
 * nothing.** Live mode charges the round trip; flat mode charges the owner's
 * deposit; and with neither available the whole order is taken online, which is
 * unreachable in practice because `codWithheldReason` has already withdrawn the
 * method — but it is written as the safe direction rather than left to the
 * caller's discipline, because the caller's discipline is what produced
 * FV-2026-00488.
 */
function codSplit(input: {
  rule: AdvanceRule;
  roundTripPaise: number | null;
  flatDepositPaise: number | null;
  forwardFreightPaise: number | null;
  rtoFreightPaise: number | null;
  grandTotalPaise: number;
}): AdvanceSplit {
  if (input.roundTripPaise !== null && input.forwardFreightPaise !== null) {
    return advanceFor({
      rule: input.rule,
      forwardFreightPaise: input.forwardFreightPaise,
      rtoFreightPaise: input.rtoFreightPaise ?? input.forwardFreightPaise,
      grandTotalPaise: input.grandTotalPaise,
    });
  }

  if (input.flatDepositPaise !== null) {
    return advanceForFlat({
      rule: input.rule,
      depositPaise: input.flatDepositPaise,
      grandTotalPaise: input.grandTotalPaise,
    });
  }

  return {
    advancePaise: input.grandTotalPaise,
    balanceDuePaise: 0,
    cappedBy: "order_total",
  };
}

/**
 * Whether Pay on Delivery is offered, and if not, which of five reasons.
 *
 * **Pure, exported and tested on its own** — `npm run audit:delivery` walks
 * every branch — because this cascade is the API half of the owner's toggle and
 * it is the only thing standing between a cash order and an unsecured one.
 * Inline inside `computeOrderTotals` it was reachable only by building a cart, a
 * quote and a settings row, which in practice means it was reachable only in
 * production.
 *
 * The order of the tests is the design, not an accident:
 *
 *   1. **`settings`** — the shop said no, or this customer has had cash
 *      withdrawn. Nothing further needs asking.
 *   2. **`below_minimum`** — the only one the customer can act on, so it must
 *      not be masked by a courier problem they cannot.
 *   3. **`no_quote`** — decision 4. Live mode with no round trip means an
 *      unsecured cash order. Flat mode is excluded here deliberately: it has no
 *      round trip *by the owner's choice*, and routing it through this branch
 *      would make switching to a festival price switch off Pay on Delivery for
 *      the whole shop.
 *   4. **`deposit_unset`** — there is no round trip and no configured deposit,
 *      so the only remaining option would be to collect nothing. This is the
 *      backstop that catches `allow_all` as well as flat mode.
 *   5. **`courier`** — Shiprocket says nobody there collects cash.
 *
 * There is no sixth branch in which the method is offered without something
 * securing it. That is the property this function exists to hold.
 */
export function codWithheldFor(input: {
  codEnabled: boolean;
  codBlocked: boolean;
  belowMinimum: boolean;
  flatMode: boolean;
  /** The live round trip, or null when there is no quote to build one from. */
  roundTripPaise: number | null;
  /** The configured flat-mode deposit, or null when the owner has not set one. */
  flatDepositPaise: number | null;
  fallbackBehaviour: "refuse_cod" | "allow_all";
  /** What Shiprocket said about cash at this PIN. */
  courierTakesCash: boolean;
}): CheckoutTotals["codWithheldReason"] {
  if (!input.codEnabled || input.codBlocked) return "settings";
  if (input.belowMinimum) return "below_minimum";

  if (
    !input.flatMode &&
    input.roundTripPaise === null &&
    input.fallbackBehaviour === "refuse_cod"
  )
    return "no_quote";

  if (input.roundTripPaise === null && input.flatDepositPaise === null)
    return "deposit_unset";

  if (!input.courierTakesCash) return "courier";
  return null;
}
