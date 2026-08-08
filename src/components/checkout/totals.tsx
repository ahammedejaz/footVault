import { formatPaise } from "@/lib/format";
import type { OrderTotals } from "@/lib/orders/types";
import { cn } from "@/lib/utils";

/**
 * Subtotal, shipping, discount, grand total — the same four rows on the
 * checkout preview and on a placed order, so a customer comparing the two is
 * comparing like with like.
 *
 * Shipping renders as the word "Free" rather than "₹0" when it has been earned:
 * a zero is a number the customer has to interpret, and the whole point of the
 * free-shipping threshold is that crossing it is legible.
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
}: {
  totals: OrderTotals;
  className?: string;
  itemCount?: number;
}) {
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
          {totals.shippingFee === 0 ? "Free" : formatPaise(totals.shippingFee)}
        </Row>

        <Row label="Discount" muted>
          {totals.discountTotal > 0
            ? `−${formatPaise(totals.discountTotal)}`
            : "—"}
        </Row>
      </dl>

      <div className="border-border mt-4 flex items-baseline justify-between border-t pt-4">
        <span className="font-mono text-xs tracking-[0.06em] uppercase">
          Total
        </span>
        <span className="font-mono text-base font-medium">
          {formatPaise(totals.grandTotal)}
        </span>
      </div>

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
  children,
}: {
  label: string;
  hint?: string;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">
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
