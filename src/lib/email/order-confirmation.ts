import { formatPaise } from "@/lib/format";
import type { EmailMessage } from "@/lib/email/types";
import type { OrderTotals, ShippingAddress } from "@/lib/orders/types";
import type { PaymentMethod } from "@/lib/payments/types";
import { SITE_URL } from "@/lib/env";
import { emailLogo, REPLY_TO } from "@/lib/email/shared";

/**
 * The order confirmation — sent on payment capture, never on order creation.
 *
 * It used to go out from the checkout action the moment the row was written,
 * which told a customer who closed the Razorpay modal "order confirmed" for an
 * order the abandonment sweep would cancel. It is now built inside
 * `applyPaymentOutcome` from the order row and its items, on the one transition
 * that moves a pending order to confirmed — so every sentence below, including
 * "we have received your payment", is true at the moment it is read.
 *
 * Both parts are written by hand. The plain-text part is not a stripped copy of
 * the HTML: it is what a text-only client and a screen reader actually receive,
 * and it is also what the console adapter prints in development, which makes it
 * the part most likely to be read during this phase.
 */
export type OrderConfirmationInput = {
  orderNumber: string;
  to: string;
  customerName: string;
  paymentMethod: PaymentMethod;
  lines: {
    productName: string;
    size: string;
    quantity: number;
    lineTotal: number;
  }[];
  totals: OrderTotals;
  /** Set when a coupon won the discount, so the line can name it. */
  couponCode?: string | null;
  shippingAddress: ShippingAddress;
};

/** What each method means for what happens next, in the customer's words. */
/**
 * What happens next, in the customer's own terms.
 *
 * The Pay-on-Delivery sentence used to read "Nothing has been charged yet." It
 * is now the opposite of the truth — an advance was charged before the order
 * was confirmed — and a confirmation email is exactly where a customer decides
 * what they think they owe. Somebody who believes they have paid nothing, or
 * who believes the advance covered the whole order, refuses the parcel at the
 * door; and a refused parcel costs the shop both legs of the delivery.
 *
 * So both figures are named, in words, in the one line most likely to be read.
 */
function whatHappensNext(method: PaymentMethod, totals: OrderTotals): string {
  if (method !== "cod") {
    return "We have received your payment. If your bank shows it as pending, it will settle shortly and your order is already confirmed.";
  }
  return (
    `You have paid ${formatPaise(totals.advanceAmount)} now — that covers delivery, ` +
    `and it has been taken off what the courier collects. ` +
    `The courier will collect the remaining ${formatPaise(totals.balanceDueOnDelivery)} ` +
    "in cash when your order arrives — please have the exact amount ready."
  );
}

/**
 * The replacement policy, at the moment it becomes relevant.
 *
 * The window runs from delivery and is short, so a customer who only reads this
 * email still has to be told — burying it on a policy page and calling it
 * disclosed is not disclosure.
 */
function replacementPolicy(orderUrl: string): string {
  const base = orderUrl.split("/order/")[0] ?? "";
  return (
    "Damaged in transit? Contact us within 24 hours of delivery and we will " +
    `replace it. We do not offer refunds or returns. ${base}/page/returns`
  );
}

function addressLines(address: ShippingAddress): string[] {
  return [
    address.recipientName,
    address.line1,
    address.line2 ?? "",
    `${address.city}, ${address.state} ${address.postalCode}`,
    address.country === "IN" ? "India" : address.country,
    address.phone,
  ].filter((line) => line.length > 0);
}

/** Minimal, and applied to every interpolated value that came from a customer. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildOrderConfirmationEmail(
  input: OrderConfirmationInput,
): EmailMessage {
  const orderUrl = `${SITE_URL}/order/${encodeURIComponent(input.orderNumber)}`;
  const address = addressLines(input.shippingAddress);

  const itemText = input.lines
    .map(
      (line) =>
        `  ${line.productName} — size ${line.size} × ${line.quantity}   ${formatPaise(line.lineTotal)}`,
    )
    .join("\n");

  /**
   * The forward leg and the coupon line are **named fields**, not arithmetic.
   * This file used to derive both — the coupon as `discountTotal −
   * prepaidDiscount`, which would have relabelled any third discount part as
   * "Coupon" on the one document a customer keeps. Every money line below
   * reads its own field; `footvault/no-derived-money-line` holds it there.
   */
  const forwardLeg = input.totals.forwardShippingFee;
  const paysOnDelivery = input.totals.balanceDueOnDelivery > 0;

  /**
   * **The discount lines, so the email's own arithmetic adds up.**
   *
   * This email had no discount row at all and was handed `discountTotal: 0` by
   * its one caller, which was harmless only for as long as no discount existed.
   * Subtotal + shipping ≠ order total is the single fastest way to make a
   * customer distrust a receipt, and it is the kind of thing they screenshot.
   *
   * Split the same way and in the same order as the checkout page and the
   * account order page — "Paying online" first, then anything else — so the
   * confirmation reads as a record of the screen the customer just left rather
   * than as a different document about the same order.
   */
  const prepaidDiscount = input.totals.prepaidDiscount;
  const otherDiscount = input.totals.couponDiscount;

  const text = [
    `Thanks, ${input.customerName}. Your order is confirmed.`,
    "",
    `Order ${input.orderNumber}`,
    orderUrl,
    "",
    "What you bought",
    itemText,
    "",
    `Subtotal        ${formatPaise(input.totals.subtotal)}`,
    ...(prepaidDiscount > 0
      ? [`Paying online   −${formatPaise(prepaidDiscount)}`]
      : []),
    ...(otherDiscount > 0
      ? [
          `${input.couponCode ? `Coupon ${input.couponCode}` : "Discount"}        −${formatPaise(otherDiscount)}`,
        ]
      : []),
    `Shipping        ${forwardLeg === 0 ? "Free" : formatPaise(forwardLeg)}`,
    ...(input.totals.codHandlingFee > 0
      ? [`Pay-on-delivery fee  ${formatPaise(input.totals.codHandlingFee)}`]
      : []),
    `Order total     ${formatPaise(input.totals.grandTotal)}`,
    // Settlement below the total: coins change who pays, not what it costs.
    ...(input.totals.coinPaid > 0
      ? [`Paid by coins   ${formatPaise(input.totals.coinPaid)}`]
      : []),
    ...(paysOnDelivery
      ? [
          "",
          `Paid now              ${formatPaise(input.totals.advanceAmount)}`,
          `To pay on delivery    ${formatPaise(input.totals.balanceDueOnDelivery)}`,
        ]
      : input.totals.coinPaid > 0 && input.totals.advanceAmount > 0
        ? [`Paid by card    ${formatPaise(input.totals.advanceAmount)}`]
        : []),
    "Prices include tax.",
    "",
    "Shipping to",
    ...address.map((line) => `  ${line}`),
    "",
    whatHappensNext(input.paymentMethod, input.totals),
    "",
    replacementPolicy(orderUrl),
    "",
    "— Foot Vault",
  ].join("\n");

  const itemHtml = input.lines
    .map(
      (line) =>
        `<tr><td style="padding:4px 12px 4px 0">${escapeHtml(line.productName)} — size ${escapeHtml(line.size)} × ${line.quantity}</td>` +
        `<td style="padding:4px 0;text-align:right">${formatPaise(line.lineTotal)}</td></tr>`,
    )
    .join("");

  const html = [
    emailLogo(),
    `<p>Thanks, ${escapeHtml(input.customerName)}. Your order is confirmed.</p>`,
    `<p><strong>Order ${escapeHtml(input.orderNumber)}</strong><br>`,
    `<a href="${orderUrl}">${orderUrl}</a></p>`,
    `<table style="border-collapse:collapse">${itemHtml}`,
    `<tr><td style="padding-top:12px">Subtotal</td><td style="padding-top:12px;text-align:right">${formatPaise(input.totals.subtotal)}</td></tr>`,
    prepaidDiscount > 0
      ? `<tr><td>Paying online</td><td style="text-align:right">−${formatPaise(prepaidDiscount)}</td></tr>`
      : "",
    otherDiscount > 0
      ? `<tr><td>${input.couponCode ? `Coupon ${escapeHtml(input.couponCode)}` : "Discount"}</td><td style="text-align:right">−${formatPaise(otherDiscount)}</td></tr>`
      : "",
    `<tr><td>Shipping</td><td style="text-align:right">${forwardLeg === 0 ? "Free" : formatPaise(forwardLeg)}</td></tr>`,
    input.totals.codHandlingFee > 0
      ? `<tr><td>Pay-on-delivery fee</td><td style="text-align:right">${formatPaise(input.totals.codHandlingFee)}</td></tr>`
      : "",
    `<tr><td><strong>Order total</strong></td><td style="text-align:right"><strong>${formatPaise(input.totals.grandTotal)}</strong></td></tr>`,
    input.totals.coinPaid > 0
      ? `<tr><td style="padding-top:12px">Paid by coins</td><td style="padding-top:12px;text-align:right">${formatPaise(input.totals.coinPaid)}</td></tr>`
      : "",
    paysOnDelivery
      ? `<tr><td style="padding-top:12px">Paid now</td><td style="padding-top:12px;text-align:right">${formatPaise(input.totals.advanceAmount)}</td></tr>` +
        `<tr><td><strong>To pay in cash on delivery</strong></td><td style="text-align:right"><strong>${formatPaise(input.totals.balanceDueOnDelivery)}</strong></td></tr>`
      : input.totals.coinPaid > 0 && input.totals.advanceAmount > 0
        ? `<tr><td>Paid by card</td><td style="text-align:right">${formatPaise(input.totals.advanceAmount)}</td></tr>`
        : "",
    `</table><p style="font-size:12px">Prices include tax.</p>`,
    `<p><strong>Shipping to</strong><br>${address.map(escapeHtml).join("<br>")}</p>`,
    `<p>${escapeHtml(whatHappensNext(input.paymentMethod, input.totals))}</p>`,
    `<p style="font-size:12px">${escapeHtml(replacementPolicy(orderUrl))}</p>`,
    `<p>— Foot Vault</p>`,
  ].join("");

  return {
    to: input.to,
    subject: `Order ${input.orderNumber} confirmed — Foot Vault`,
    text,
    html,
    replyTo: REPLY_TO,
  };
}
