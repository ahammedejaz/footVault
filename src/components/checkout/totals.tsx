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
 * The discount row is always drawn, with an em dash. Coupon validation is Phase
 * 8, and a total that grows a new row when the feature lands is a layout that
 * moves under someone mid-checkout.
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
}: {
  totals: OrderTotals;
  className?: string;
  itemCount?: number;
  pendingDelivery?: boolean;
}) {
  /**
   * `shippingFee` is the whole delivery charge and `codHandlingFee` says how
   * much of it is the Pay-on-Delivery extra. Drawing them apart is this
   * component's job and **this is the only place that subtraction happens** —
   * every other surface stores and passes the total, so no read site has to
   * remember to add two columns back together.
   */
  const forwardLeg = totals.shippingFee - totals.codHandlingFee;

  /** Money owed at the door is what makes an order a Pay-on-Delivery order. */
  const paysOnDelivery = totals.balanceDueOnDelivery > 0;

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
            label="Pay-on-delivery fee"
            hint=" — covers the return journey if the parcel is refused"
          >
            {formatPaise(totals.codHandlingFee)}
          </Row>
        ) : null}

        <Row label="Discount" muted>
          {totals.discountTotal > 0
            ? `−${formatPaise(totals.discountTotal)}`
            : "—"}
        </Row>
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
          <p className="text-muted-foreground text-xs text-pretty">
            {formatPaise(totals.advanceAmount)} confirms your order now. The
            courier collects{" "}
            {formatPaise(totals.balanceDueOnDelivery)} in cash when it arrives.
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
  muted,
  strong,
  children,
}: {
  label: string;
  hint?: string;
  muted?: boolean;
  strong?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={cn("text-muted-foreground", strong && "text-foreground")}>
        {label}
        {hint ? <span className="sr-only">{hint}</span> : null}
      </dt>
      <dd
        className={cn(
          "font-mono font-medium",
          muted && "text-muted-foreground font-normal",
        )}
      >
        {children}
      </dd>
    </div>
  );
}
