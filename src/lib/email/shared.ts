import { SITE_URL } from "@/lib/env";
import type { ShippingAddress } from "@/lib/orders/types";

/**
 * The pieces every order email needs, in one place.
 *
 * Extracted when the confirmation stopped being the only email. Six templates
 * each with their own `escapeHtml` is six chances for one of them to be the
 * copy that forgot, and the one that forgets is the one that renders a
 * customer's apostrophe as a broken tag — or worse, renders a product name
 * containing `<` as markup.
 *
 * Deliberately not a layout framework. These emails are plain enough that a
 * shared wrapper would cost more in indirection than it saves in duplication;
 * what is shared here is the part where being inconsistent is a *defect*, not
 * the part where being inconsistent is merely untidy.
 */

/** Minimal, and applied to every interpolated value that came from a customer. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function orderUrl(orderNumber: string): string {
  return `${SITE_URL}/order/${encodeURIComponent(orderNumber)}`;
}

export function addressLines(address: ShippingAddress): string[] {
  return [
    address.recipientName,
    address.line1,
    address.line2 ?? "",
    `${address.city}, ${address.state} ${address.postalCode}`,
    address.country === "IN" ? "India" : address.country,
    address.phone,
  ].filter((line) => line.length > 0);
}

/**
 * The replacement policy, at the moment it becomes relevant.
 *
 * The window runs from delivery and is short, so a customer who only reads one
 * email still has to be told — burying it on a policy page and calling it
 * disclosed is not disclosure. It rides on the confirmation and on the
 * delivered notice, which are the two a customer keeps.
 */
export function replacementPolicy(): string {
  return (
    "Damaged in transit? Contact us within 24 hours of delivery and we will " +
    `replace it. We do not offer refunds or returns. ${SITE_URL}/page/returns`
  );
}

export const SIGN_OFF = "— Foot Vault";

/**
 * How long a refund takes to appear, quoted in exactly one place.
 *
 * The order page, the timeline entry and the refund email all say this. Two
 * typed copies of "5–7 working days" is one edit away from telling a customer
 * two different things about their own money.
 */
export { REFUND_ARRIVAL_WINDOW } from "@/lib/orders/customer-copy";
