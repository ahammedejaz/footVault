import { formatPaise } from "@/lib/format";
import type { OrderTotals } from "@/lib/orders/types";
import { cn } from "@/lib/utils";

/**
 * The money, on the checkout preview and on a placed order, from one component
 * so a customer comparing the two is comparing like with like.
 *
 * **The Pay-on-Delivery split is the highest-stakes copy on this site.** A
 * customer who thinks they are paying nothing today, or who thinks the ₹220
 * they just paid was the whole order, will refuse the parcel at the door — and
 * a refused parcel costs the shop both legs of the delivery. So when money is
 * owed at the door, all three figures are drawn explicitly and separately: what
 * is being charged now, what the courier will collect, and what the two add up
 * to. Never a bare "COD" with the advance undisclosed.
 *
 * Shipping renders as the word "Free" rather than "₹0" when it has been earned:
 * a zero is a number the customer has to interpret, and the whole point of the
 * free-delivery threshold is that crossing it is legible.
 *
 * The discount row exists only when there is a discount. It used to be always
 * drawn with an em dash, on the argument that a row appearing mid-checkout is
 * a layout shift — but the owner's reading of the dash is the correct one: an
 * empty row beside real numbers reads as a number that failed to arrive, not
 * as the absence of one (2026-08-10). A coupon applying is a real content
 * change, and the row appearing with it is the honest rendering.
 */
export function Totals({
  totals,
  className,
  /** Named for the screen reader, since "Subtotal" alone begs "of what?". */
  itemCount,
  /**
   * True before a destination is known. Delivery is quoted by the courier from
   * the PIN code, so until one exists the honest answer is "at checkout" — not
   * ₹0, which reads as free.
   */
  pendingDelivery = false,
  couponCode = null,
}: {
  totals: OrderTotals;
  className?: string;
  itemCount?: number;
  pendingDelivery?: boolean;
  /**
   * The applied code, so the row can say *which* coupon rather than a bare
   * "Discount". A coupon and the prepaid discount combine now (owner's
   * decision, 2026-08-10), and each is its own named row below — this
   * component never had to know about the old larger-of-two rule, because it
   * always drew whatever parts were non-zero.
   */
  couponCode?: string | null;
}) {
  /**
   * Every figure below is a **named field read**, never arithmetic. This file
   * used to hold the codebase's one blessed subtraction (the forward leg out
   * of `shippingFee`), and a second, unblessed one — the coupon line derived
   * as `discountTotal − prepaidDiscount`, which would have silently printed
   * any third discount part under the coupon's name. Both are fields on
   * `OrderTotals` now, and `footvault/no-derived-money-line` fails the build
   * on the next `-` between money fields in a component.
   */
  const forwardLeg = totals.forwardShippingFee;

  /** Money owed at the door is what makes an order a Pay-on-Delivery order. */
  const paysOnDelivery = totals.balanceDueOnDelivery > 0;

  // No `?? 0` any more: `prepaidDiscount` is required on `OrderTotals`, so a
  // read site that forgets it fails to compile rather than rendering a silent
  // zero — which is what this row did for the whole of Phase 8.
  const prepaidDiscount = totals.prepaidDiscount;
  const otherDiscount = totals.couponDiscount;

  return (
    <div className={className}>
      <dl className="space-y-2 text-sm">
        <Row
          label="Subtotal"
          hint={itemCount ? ` for ${itemCount} items` : undefined}
        >
          {formatPaise(totals.subtotal)}
        </Row>

        <Row label="Shipping">
          {pendingDelivery
            ? "At checkout"
            : forwardLeg === 0
              ? "Free"
              : formatPaise(forwardLeg)}
        </Row>

        {totals.codHandlingFee > 0 ? (
          <Row
            label="Cash-handling fee"
            /*
              **The old hint said this covered the return journey. It has not
              since Phase 7.**

              The return leg moved into the advance — money the customer pays
              online and which is netted straight off what the courier collects.
              This line is Shiprocket's own charge for collecting cash at the
              door, `cod_charges`, and nothing else. Describing it as covering a
              return was a sentence a customer could reasonably dispute, and they
              would have been right.

              It matters more now than it did: since the free-delivery threshold
              started applying to Pay on Delivery, this is often the *only* line
              a cash customer sees under a free delivery, so it is the one they
              will ask about.
            */
            hint=" — what the courier charges us to collect cash at your door"
          >
            {formatPaise(totals.codHandlingFee)}
          </Row>
        ) : null}

        {/*
          The prepaid discount is drawn as its own line rather than folded into
          "Discount". It is the reason a customer might change payment method,
          and a total that is quietly lower persuades nobody — the owner's rule
          everywhere in this codebase is that a difference between two payment
          methods has to be something a customer can see and point at.
        */}
        {prepaidDiscount > 0 ? (
          <Row
            label="Paying online"
            hint=" — our thanks for settling up front"
          >
            −{formatPaise(prepaidDiscount)}
          </Row>
        ) : null}

        {otherDiscount > 0 ? (
          <Row label={couponCode ? `Coupon ${couponCode}` : "Discount"}>
            −{formatPaise(otherDiscount)}
          </Row>
        ) : null}
      </dl>

      <div className="border-border mt-4 flex items-baseline justify-between border-t pt-4">
        <span className="font-mono text-xs tracking-[0.06em] uppercase">
          {paysOnDelivery ? "Order total" : "Total"}
        </span>
        <span className="font-mono text-base font-medium">
          {formatPaise(totals.grandTotal)}
        </span>
      </div>

      {paysOnDelivery ? (
        <div className="border-border mt-4 space-y-2 rounded-lg border p-3">
          <dl className="space-y-2 text-sm">
            <Row label="Pay now" strong>
              {formatPaise(totals.advanceAmount)}
            </Row>
            <Row label="Pay in cash on delivery" strong>
              {formatPaise(totals.balanceDueOnDelivery)}
            </Row>
          </dl>
          {/*
            The brief's sentence, verbatim, because it is the one that stops a
            customer thinking they are being charged twice: the amount paid now
            is the delivery, and it is *taken off* what the courier collects
            rather than added to it.
          */}
          <p className="text-muted-foreground text-xs text-pretty">
            The amount you pay now covers delivery. The rest is paid in cash
            when your order arrives.
          </p>
        </div>
      ) : null}

      <p className="text-muted-foreground mt-2 text-xs text-pretty">
        Inclusive of all taxes.
      </p>
    </div>
  );
}

function Row({
  label,
  hint,
  strong,
  children,
}: {
  label: string;
  hint?: string;
  strong?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={cn("text-muted-foreground", strong && "text-foreground")}>
        {label}
        {hint ? <span className="sr-only">{hint}</span> : null}
      </dt>
      <dd className="font-mono font-medium">{children}</dd>
    </div>
  );
}
