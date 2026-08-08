import { formatPaise } from "@/lib/format";
import type { FreeShipping } from "@/lib/cart-types";

/**
 * How far off free shipping is.
 *
 * The threshold comes from `site_settings.shipping`, never a constant: the
 * owner changes it in /admin/settings and this follows without a deploy.
 * Hardcoding it here would make the storefront and the shipping rules two
 * separate sources of the same fact.
 *
 * The *fee* is not shown, because a bag page cannot know it. Delivery is priced
 * by Shiprocket from the destination PIN code, and this component used to
 * display a flat figure from settings that checkout then contradicted.
 *
 * The bar is `aria-hidden` and the sentence above it carries the whole message,
 * because "72% of the way to free shipping" is not what anybody wants to know —
 * "₹560 away" is.
 */
export function FreeShippingMeter({
  freeShipping,
}: {
  freeShipping: FreeShipping;
}) {
  const { thresholdPaise, remainingPaise, qualified } = freeShipping;
  if (thresholdPaise <= 0) return null;

  const progress = Math.min(
    1,
    (thresholdPaise - remainingPaise) / thresholdPaise,
  );

  return (
    <div>
      <p className="text-sm text-pretty">
        {qualified ? (
          <span className="text-state-stock font-medium">
            Free shipping — you are over {formatPaise(thresholdPaise)}
          </span>
        ) : (
          <>
            <span className="font-mono font-medium tabular-nums">
              {formatPaise(remainingPaise)}
            </span>{" "}
            <span className="text-muted-foreground">
              away from free shipping. Below that, delivery is priced by the
              courier at checkout.
            </span>
          </>
        )}
      </p>
      <div className="bg-fog mt-2 h-1 overflow-hidden rounded-full" aria-hidden>
        <div
          className="bg-orange h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
    </div>
  );
}
