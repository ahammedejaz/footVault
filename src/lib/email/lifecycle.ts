import { formatPaise } from "@/lib/format";
import type { EmailMessage } from "@/lib/email/types";
import {
  addressLines,
  emailLogo,
  escapeHtml,
  orderUrl,
  REFUND_ARRIVAL_WINDOW,
  replacementPolicy,
  REPLY_TO,
  SIGN_OFF,
} from "@/lib/email/shared";
import type { ShippingAddress } from "@/lib/orders/types";
import type { PaymentMethod } from "@/lib/payments/types";

/**
 * The emails an order sends after it is placed.
 *
 * The confirmation lives in `order-confirmation.ts` because it is composed from
 * what the checkout action already holds and must not re-read the order it just
 * wrote. Everything here is the opposite case: each is sent from a place that
 * has *just read or written* the order, so each takes the narrow set of fields
 * that place already has rather than an `OrderView` it would have to fetch.
 *
 * ## The rule these all follow
 *
 * **Say what changed, say what it means for the customer, and never say
 * anything the sending code cannot prove.** The one that matters is the refund
 * notice: it is sent when a refund is *confirmed by the provider*, never when
 * one is requested, because "your money is on its way back" is a promise the
 * shop cannot keep on the strength of an API call that has not settled.
 *
 * The other three are safe by construction — shipped, delivered and captured
 * are all facts recorded before the send is attempted.
 */

/* --------------------------------------------------------- payment taken -- */

export type PaymentCapturedInput = {
  orderNumber: string;
  to: string;
  customerName: string;
  amountPaise: number;
  /** Present only on Pay-on-Delivery; what the courier still collects. */
  balanceDueOnDelivery: number;
};

/**
 * Sent when the webhook confirms the money, not when the modal closes.
 *
 * A customer who dismissed the Razorpay modal and a customer whose bank is slow
 * both see "we have not seen your payment settle yet" on the order page. This
 * email is the other half of that sentence arriving — so it only goes out on
 * the authoritative event.
 */
export function buildPaymentCapturedEmail(
  input: PaymentCapturedInput,
): EmailMessage {
  const url = orderUrl(input.orderNumber);
  const owes = input.balanceDueOnDelivery > 0;

  const closing = owes
    ? `The courier will collect the remaining ${formatPaise(input.balanceDueOnDelivery)} in cash when your order arrives — please have the exact amount ready.`
    : "Nothing further is due. We will email you again when it ships.";

  const text = [
    `${input.customerName}, we have your payment.`,
    "",
    `Order ${input.orderNumber}`,
    url,
    "",
    `Paid            ${formatPaise(input.amountPaise)}`,
    ...(owes
      ? [`Due on delivery ${formatPaise(input.balanceDueOnDelivery)}`]
      : []),
    "",
    closing,
    "",
    SIGN_OFF,
  ].join("\n");

  const html = [
    emailLogo(),
    `<p>${escapeHtml(input.customerName)}, we have your payment.</p>`,
    `<p><strong>Order ${escapeHtml(input.orderNumber)}</strong><br>`,
    `<a href="${url}">${url}</a></p>`,
    `<table style="border-collapse:collapse">`,
    `<tr><td style="padding:4px 12px 4px 0">Paid</td><td style="padding:4px 0;text-align:right">${formatPaise(input.amountPaise)}</td></tr>`,
    owes
      ? `<tr><td style="padding:4px 12px 4px 0"><strong>Due on delivery</strong></td><td style="padding:4px 0;text-align:right"><strong>${formatPaise(input.balanceDueOnDelivery)}</strong></td></tr>`
      : "",
    `</table>`,
    `<p>${escapeHtml(closing)}</p>`,
    `<p>${SIGN_OFF}</p>`,
  ].join("");

  return {
    to: input.to,
    subject: `Payment received for order ${input.orderNumber} — Foot Vault`,
    text,
    html,
    replyTo: REPLY_TO,
  };
}

/* ---------------------------------------------------------------- shipped -- */

export type ShippedInput = {
  orderNumber: string;
  to: string;
  customerName: string;
  courierName: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  balanceDueOnDelivery: number;
};

/**
 * The tracking email, which has to survive having no tracking.
 *
 * A parcel can be handed over before the courier returns an AWB, and a shipped
 * notice that renders "Track your parcel: null" is worse than one that does not
 * mention tracking at all. Every tracking field is therefore optional in the
 * type and absent from the body when it is missing — the customer is told the
 * parcel is on its way, which is the fact, and nothing is invented.
 */
export function buildShippedEmail(input: ShippedInput): EmailMessage {
  const url = orderUrl(input.orderNumber);
  const hasTracking = Boolean(input.trackingNumber ?? input.trackingUrl);
  const courier = input.courierName ?? "our courier";

  const trackingText = hasTracking
    ? [
        "",
        ...(input.courierName ? [`Courier         ${input.courierName}`] : []),
        ...(input.trackingNumber
          ? [`Tracking        ${input.trackingNumber}`]
          : []),
        ...(input.trackingUrl ? [input.trackingUrl] : []),
      ]
    : [
        "",
        `${courier} has your parcel. A tracking number usually appears within a day — your order page will show it as soon as it does.`,
      ];

  const cashLine =
    input.balanceDueOnDelivery > 0
      ? `Please have ${formatPaise(input.balanceDueOnDelivery)} in cash ready for the courier.`
      : "Nothing is due on delivery — your order is paid in full.";

  const text = [
    `${input.customerName}, your order is on its way.`,
    "",
    `Order ${input.orderNumber}`,
    url,
    ...trackingText,
    "",
    cashLine,
    "",
    SIGN_OFF,
  ].join("\n");

  const html = [
    emailLogo(),
    `<p>${escapeHtml(input.customerName)}, your order is on its way.</p>`,
    `<p><strong>Order ${escapeHtml(input.orderNumber)}</strong><br>`,
    `<a href="${url}">${url}</a></p>`,
    hasTracking
      ? [
          `<p>`,
          input.courierName
            ? `Courier: ${escapeHtml(input.courierName)}<br>`
            : "",
          input.trackingNumber
            ? `Tracking: <strong>${escapeHtml(input.trackingNumber)}</strong><br>`
            : "",
          input.trackingUrl
            ? `<a href="${escapeHtml(input.trackingUrl)}">Track your parcel</a>`
            : "",
          `</p>`,
        ].join("")
      : `<p>${escapeHtml(courier)} has your parcel. A tracking number usually appears within a day — your order page will show it as soon as it does.</p>`,
    `<p>${escapeHtml(cashLine)}</p>`,
    `<p>${SIGN_OFF}</p>`,
  ].join("");

  return {
    to: input.to,
    subject: `Order ${input.orderNumber} has shipped — Foot Vault`,
    text,
    html,
    replyTo: REPLY_TO,
  };
}

/* -------------------------------------------------------------- delivered -- */

export type DeliveredInput = {
  orderNumber: string;
  to: string;
  customerName: string;
};

/**
 * Delivered, and the one email where the replacement window is the point.
 *
 * The window runs from delivery and is 24 hours. This is the moment it starts,
 * so this is the email that has to carry it — a customer who finds a scuffed
 * box on Sunday evening should not have to go looking for the policy.
 */
export function buildDeliveredEmail(input: DeliveredInput): EmailMessage {
  const url = orderUrl(input.orderNumber);

  const text = [
    `${input.customerName}, your order has been delivered.`,
    "",
    `Order ${input.orderNumber}`,
    url,
    "",
    replacementPolicy(),
    "",
    "If something is not right, reply to this email and we will sort it out.",
    "",
    SIGN_OFF,
  ].join("\n");

  const html = [
    emailLogo(),
    `<p>${escapeHtml(input.customerName)}, your order has been delivered.</p>`,
    `<p><strong>Order ${escapeHtml(input.orderNumber)}</strong><br>`,
    `<a href="${url}">${url}</a></p>`,
    `<p>${escapeHtml(replacementPolicy())}</p>`,
    `<p>If something is not right, reply to this email and we will sort it out.</p>`,
    `<p>${SIGN_OFF}</p>`,
  ].join("");

  return {
    to: input.to,
    subject: `Order ${input.orderNumber} delivered — Foot Vault`,
    text,
    html,
    replyTo: REPLY_TO,
  };
}

/* --------------------------------------------------------------- refunded -- */

export type RefundedInput = {
  orderNumber: string;
  to: string;
  customerName: string;
  amountPaise: number;
  /** True when this settles the order completely. */
  isFull: boolean;
};

/**
 * Sent on a **confirmed** refund only.
 *
 * `refunds.status = 'processed'` is the trigger, never `'pending'`. A refund
 * that Razorpay accepted and then failed would otherwise have told the customer
 * their money was coming back before it was, and the follow-up conversation is
 * one the shop cannot win.
 *
 * The arrival window is the shared constant, so this email and the order page
 * cannot quote different numbers.
 */
export function buildRefundedEmail(input: RefundedInput): EmailMessage {
  const url = orderUrl(input.orderNumber);
  const scope = input.isFull
    ? "That settles the order in full."
    : "This is a partial refund; the rest of the order is unaffected.";

  const text = [
    `${input.customerName}, we have refunded ${formatPaise(input.amountPaise)}.`,
    "",
    `Order ${input.orderNumber}`,
    url,
    "",
    scope,
    `It takes ${REFUND_ARRIVAL_WINDOW} to appear, and it goes back to the card or account you paid from — we cannot send it anywhere else.`,
    "",
    SIGN_OFF,
  ].join("\n");

  const html = [
    emailLogo(),
    `<p>${escapeHtml(input.customerName)}, we have refunded <strong>${formatPaise(input.amountPaise)}</strong>.</p>`,
    `<p><strong>Order ${escapeHtml(input.orderNumber)}</strong><br>`,
    `<a href="${url}">${url}</a></p>`,
    `<p>${escapeHtml(scope)}</p>`,
    `<p>It takes ${escapeHtml(REFUND_ARRIVAL_WINDOW)} to appear, and it goes back to the card or account you paid from — we cannot send it anywhere else.</p>`,
    `<p>${SIGN_OFF}</p>`,
  ].join("");

  return {
    to: input.to,
    subject: `Refund sent for order ${input.orderNumber} — Foot Vault`,
    text,
    html,
    replyTo: REPLY_TO,
  };
}

/* ------------------------------------------------------- the owner's copy -- */

export type OwnerNewOrderInput = {
  orderNumber: string;
  to: string;
  placedAt: string;
  paymentMethod: PaymentMethod;
  lines: {
    productName: string;
    sku: string;
    size: string;
    colour: string;
    quantity: number;
  }[];
  shippingAddress: ShippingAddress;
  grandTotal: number;
  advanceAmount: number;
  balanceDueOnDelivery: number;
  contactPhone: string;
  contactEmail: string | null;
};

/**
 * The one the shop owner actually acts on.
 *
 * Written to be read on a phone, at the top, without opening anything: what was
 * bought including **size and SKU**, where it goes, how it was paid, and — the
 * line that decides whether a parcel is refused at the door — exactly what the
 * courier collects.
 *
 * `collects` is stated even when it is zero, as "nothing to collect". An absent
 * line reads as "I do not know", and the owner packing the parcel has to be able
 * to tell the difference between a prepaid order and one whose cash figure
 * failed to render.
 */
export function buildOwnerNewOrderEmail(
  input: OwnerNewOrderInput,
): EmailMessage {
  const url = `${orderUrl(input.orderNumber)}`;
  const address = addressLines(input.shippingAddress);
  const method =
    input.paymentMethod === "cod" ? "Pay on Delivery" : "Paid online";

  const collects =
    input.balanceDueOnDelivery > 0
      ? `COLLECT ${formatPaise(input.balanceDueOnDelivery)} IN CASH`
      : "Nothing to collect — paid in full";

  const itemText = input.lines
    .map(
      (line) =>
        `  ${line.quantity} × ${line.productName}\n` +
        `      size ${line.size} · ${line.colour} · ${line.sku}`,
    )
    .join("\n");

  const text = [
    `New order ${input.orderNumber} — ${method}`,
    collects,
    "",
    itemText,
    "",
    "Ship to",
    ...address.map((line) => `  ${line}`),
    "",
    `Phone           ${input.contactPhone}`,
    ...(input.contactEmail ? [`Email           ${input.contactEmail}`] : []),
    "",
    `Order total     ${formatPaise(input.grandTotal)}`,
    `Paid now        ${formatPaise(input.advanceAmount)}`,
    `On delivery     ${formatPaise(input.balanceDueOnDelivery)}`,
    "",
    `Placed ${input.placedAt}`,
    url,
  ].join("\n");

  const itemHtml = input.lines
    .map(
      (line) =>
        `<li><strong>${line.quantity} × ${escapeHtml(line.productName)}</strong><br>` +
        `<span style="font-family:monospace">size ${escapeHtml(line.size)} · ${escapeHtml(line.colour)} · ${escapeHtml(line.sku)}</span></li>`,
    )
    .join("");

  const html = [
    emailLogo(),
    `<p style="font-size:18px"><strong>New order ${escapeHtml(input.orderNumber)}</strong> — ${escapeHtml(method)}</p>`,
    `<p style="font-size:16px;padding:8px;background:#f4f4f5"><strong>${escapeHtml(collects)}</strong></p>`,
    `<ul>${itemHtml}</ul>`,
    `<p><strong>Ship to</strong><br>${address.map(escapeHtml).join("<br>")}</p>`,
    `<p>Phone: ${escapeHtml(input.contactPhone)}`,
    input.contactEmail ? `<br>Email: ${escapeHtml(input.contactEmail)}` : "",
    `</p>`,
    `<table style="border-collapse:collapse">`,
    `<tr><td style="padding:2px 12px 2px 0">Order total</td><td style="text-align:right">${formatPaise(input.grandTotal)}</td></tr>`,
    `<tr><td style="padding:2px 12px 2px 0">Paid now</td><td style="text-align:right">${formatPaise(input.advanceAmount)}</td></tr>`,
    `<tr><td style="padding:2px 12px 2px 0">On delivery</td><td style="text-align:right">${formatPaise(input.balanceDueOnDelivery)}</td></tr>`,
    `</table>`,
    `<p style="font-size:12px">Placed ${escapeHtml(input.placedAt)}<br><a href="${url}">${url}</a></p>`,
  ].join("");

  return {
    to: input.to,
    subject: `New order ${input.orderNumber} — ${collects}`,
    text,
    html,
    replyTo: REPLY_TO,
  };
}
