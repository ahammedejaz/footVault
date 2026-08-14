/**
 * Turning the shop's own contact details into links a customer can press.
 *
 * Dependency-free and separate from `components/storefront/contact-details.tsx`
 * so `audit:contact` and `audit:reachability` can assert on the *same*
 * normalisation the page renders, rather than on a second copy of it. A gate
 * that reimplements the rule it is checking proves only that two people agreed.
 */

/**
 * `+91 91602 52643` → `https://wa.me/919160252643`.
 *
 * wa.me takes digits only — no plus, no spaces, no dashes — and the country
 * code included. A number stored without one produces a link that opens
 * WhatsApp and finds nobody, so this returns null rather than building a link
 * it cannot trust, and the caller renders the number as plain text instead.
 *
 * Ten digits is India's national number and is the shape the owner is most
 * likely to type; it is prefixed rather than rejected, because "91602 52643"
 * meaning +91 91602 52643 is not a guess about the business — it is the country
 * the shop is in.
 */
export function whatsappHref(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `https://wa.me/91${digits}`;
  if (digits.length >= 11 && digits.length <= 15)
    return `https://wa.me/${digits}`;
  return null;
}
