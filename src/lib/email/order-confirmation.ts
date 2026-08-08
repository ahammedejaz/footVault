import { formatPaise } from "@/lib/format";
import type { EmailMessage } from "@/lib/email/types";
import type { OrderTotals, ShippingAddress } from "@/lib/orders/types";
import type { PaymentMethod } from "@/lib/payments/types";
import { SITE_URL } from "@/lib/env";

/**
 * The one email Phase 5 sends.
 *
 * A narrow input rather than an `OrderView`, because the confirmation is
 * composed from what the checkout action already holds — it must not have to
 * re-read the order it just wrote, and a read-after-write against a replica is
 * exactly the sort of thing that turns "your order is placed" into a 500.
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
  shippingAddress: ShippingAddress;
};

/** What each method means for what happens next, in the customer's words. */
function whatHappensNext(method: PaymentMethod): string {
  return method === "cod"
    ? "You will pay the delivery agent in cash when your order arrives. Nothing has been charged yet."
    : "We have received your payment. If your bank shows it as pending, it will settle shortly and your order is already confirmed.";
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

  const text = [
    `Thanks, ${input.customerName}. Your order is placed.`,
    "",
    `Order ${input.orderNumber}`,
    orderUrl,
    "",
    "What you bought",
    itemText,
    "",
    `Subtotal        ${formatPaise(input.totals.subtotal)}`,
    `Shipping        ${input.totals.shippingFee === 0 ? "Free" : formatPaise(input.totals.shippingFee)}`,
    `Total           ${formatPaise(input.totals.grandTotal)}`,
    "Prices include tax.",
    "",
    "Shipping to",
    ...address.map((line) => `  ${line}`),
    "",
    whatHappensNext(input.paymentMethod),
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
    `<p>Thanks, ${escapeHtml(input.customerName)}. Your order is placed.</p>`,
    `<p><strong>Order ${escapeHtml(input.orderNumber)}</strong><br>`,
    `<a href="${orderUrl}">${orderUrl}</a></p>`,
    `<table style="border-collapse:collapse">${itemHtml}`,
    `<tr><td style="padding-top:12px">Subtotal</td><td style="padding-top:12px;text-align:right">${formatPaise(input.totals.subtotal)}</td></tr>`,
    `<tr><td>Shipping</td><td style="text-align:right">${input.totals.shippingFee === 0 ? "Free" : formatPaise(input.totals.shippingFee)}</td></tr>`,
    `<tr><td><strong>Total</strong></td><td style="text-align:right"><strong>${formatPaise(input.totals.grandTotal)}</strong></td></tr>`,
    `</table><p style="font-size:12px">Prices include tax.</p>`,
    `<p><strong>Shipping to</strong><br>${address.map(escapeHtml).join("<br>")}</p>`,
    `<p>${escapeHtml(whatHappensNext(input.paymentMethod))}</p>`,
    `<p>— Foot Vault</p>`,
  ].join("");

  return {
    to: input.to,
    subject: `Order ${input.orderNumber} confirmed — Foot Vault`,
    text,
    html,
  };
}
