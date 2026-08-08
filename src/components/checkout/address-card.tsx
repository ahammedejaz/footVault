import type { ShippingAddress } from "@/lib/orders/types";

/**
 * An address, laid out the way a courier reads one.
 *
 * Recipient, street, city, state and PIN on their own lines, phone last. The
 * PIN is mono because it is a code rather than a word, and because a six-digit
 * number set in the body face is the field a customer squints at to check.
 */
export function AddressCard({ address }: { address: ShippingAddress }) {
  return (
    <address className="text-sm not-italic">
      <span className="block font-medium">{address.recipientName}</span>
      <span className="text-muted-foreground mt-1 block text-pretty">
        {address.line1}
        {address.line2 ? (
          <>
            <br />
            {address.line2}
          </>
        ) : null}
        <br />
        {address.city}, {address.state}
      </span>
      <span className="text-muted-foreground mt-1 block font-mono text-xs tracking-[0.06em]">
        PIN {address.postalCode} · +91 {address.phone}
      </span>
    </address>
  );
}
