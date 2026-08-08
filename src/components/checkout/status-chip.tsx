import { ORDER_STATUS_COPY } from "@/components/checkout/order-format";
import type { OrderStatus } from "@/lib/orders/types";
import { cn } from "@/lib/utils";

/**
 * Where an order has got to.
 *
 * Deliberately not colour-coded. `docs/design-system.md` keeps green for admin
 * status columns and orange as the storefront's single accent, and a customer
 * looking at one order does not need a colour key — they need the word. So the
 * chip carries weight instead of hue: the live states are filled navy, and the
 * two terminal ones are outlined and quiet, because "Cancelled" shouted in a
 * filled chip reads as an error the customer has to do something about.
 */
export function StatusChip({
  status,
  className,
}: {
  status: OrderStatus;
  className?: string;
}) {
  const spent = status === "cancelled" || status === "returned";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-4xl px-3 py-1 font-mono text-xs tracking-[0.06em] uppercase",
        spent
          ? "border-border text-muted-foreground border"
          : "bg-foreground text-background",
        className,
      )}
    >
      {ORDER_STATUS_COPY[status].label}
    </span>
  );
}
