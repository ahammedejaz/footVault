import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The coupon field, present and honest.
 *
 * Validation is Phase 8. Shipping a live-looking input that swallows every code
 * would be worse than not shipping one at all — a customer with a working code
 * would type it, see nothing happen, and conclude the code is dead or the shop
 * is broken. So the field is here, styled, and plainly not ready: disabled,
 * labelled, and with the reason next to it.
 *
 * It is here at all rather than hidden because the space it occupies is part of
 * the layout that Phase 8 lands into, and because a bag with no coupon field
 * reads as a shop that does not do offers.
 */
export function CouponField() {
  return (
    <div>
      <Label htmlFor="coupon" className="font-mono text-xs tracking-[0.06em] uppercase">
        Coupon code
      </Label>
      <div className="mt-2 flex gap-2">
        <Input
          id="coupon"
          name="coupon"
          disabled
          placeholder="FOOTVAULT10"
          aria-describedby="coupon-status"
          className="font-mono"
        />
      </div>
      <p id="coupon-status" className="text-muted-foreground mt-2 text-xs text-pretty">
        Codes are not being accepted yet. This opens with the next release — nothing
        you type here would apply today.
      </p>
    </div>
  );
}
