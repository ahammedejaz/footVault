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
    `Damaged in transit? Email ${REPLY_TO} within 24 hours of delivery and ` +
    "we will replace it. We do not offer refunds or returns. " +
    `${SITE_URL}/page/returns`
  );
}

export const SIGN_OFF = "— Foot Vault";

/**
 * The logo, at the top of every template's HTML.
 *
 * An absolute URL because an email has no origin to resolve against, and the
 * flattened-on-white variant because mail clients put unpredictable colours
 * behind transparency — Gmail's dark mode would otherwise sit navy text on
 * navy. The plain-text part of every email is untouched: a text-part reader
 * chose not to load images.
 */
export function emailLogo(): string {
  return `<img src="${SITE_URL}/brand/logo-email.png" width="150" height="148" alt="Foot Vault" style="display:block;border:0;margin:0 0 12px">`;
}

/**
 * Where a customer's reply goes.
 *
 * **The shop's own domain, now that mail to it reaches a person.** Resend
 * Inbound accepts anything `@footvault.in` and `/api/email/inbound` forwards it
 * to the owner's Gmail, proven end to end before this address was put in front
 * of customers.
 *
 * It was a Gmail address until that was true. A reply-to nobody reads is worse
 * than no reply-to: the send succeeds, the delivery succeeds, and the message
 * is still lost, with no bounce to notice and no error to log. So the order of
 * operations mattered — forwarding first, then this.
 *
 * The one that decides it is the damage claim. The replacement window is 24
 * hours from delivery (`replacementPolicy` above), the delivered notice is the
 * email a customer is holding when they open the box, and "I replied to your
 * email" has to reach a human inside that window or the shop has quietly made
 * its own policy unusable.
 *
 * A constant rather than an env var, deliberately. An unset variable puts the
 * system straight back into the failure this exists to prevent, and does it
 * silently — nothing about a missing reply-to looks like a fault from the
 * sending side. `scripts/audit/emails.ts` asserts every builder sets it.
 */
export const REPLY_TO = "inquiry@footvault.in";

/**
 * How long a refund takes to appear, quoted in exactly one place.
 *
 * The order page, the timeline entry and the refund email all say this. Two
 * typed copies of "5–7 working days" is one edit away from telling a customer
 * two different things about their own money.
 */
export { REFUND_ARRIVAL_WINDOW } from "@/lib/orders/customer-copy";
