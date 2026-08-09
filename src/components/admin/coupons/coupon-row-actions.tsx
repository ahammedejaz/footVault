"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Power, PowerOff, Trash2 } from "lucide-react";

import { ConfirmAction } from "@/components/admin/confirm-action";
import {
  CouponForm,
  type AudienceMember,
  type CouponDraft,
} from "@/components/admin/coupons/coupon-form";
import { Button } from "@/components/ui/button";
import { deleteCoupon, setCouponActive } from "@/lib/actions/admin/coupons";
import { toast } from "@/lib/toast";

/**
 * On/off, edit and delete for one coupon.
 *
 * Same shape as the brand row: **delete is only offered when it can
 * succeed** — a redeemed coupon owns ledger history, and the action refuses to
 * orphan it. The row says what to do instead (switch it off), because a red
 * button that always refuses teaches the owner to ignore red buttons.
 */
export function CouponRowActions({
  coupon,
  audience,
  redemptionCount,
}: {
  coupon: CouponDraft;
  audience: AudienceMember[];
  redemptionCount: number;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  async function toggle() {
    setPending(true);
    const result = await setCouponActive({
      id: coupon.id,
      isActive: !coupon.isActive,
    });
    setPending(false);
    if (!result.ok) {
      toast.failed(result.message);
      return;
    }
    toast.done(
      coupon.isActive
        ? `${coupon.code} is switched off`
        : `${coupon.code} is switched on`,
      coupon.isActive
        ? "Customers are refused it exactly as if it never existed."
        : "Its schedule and limits apply from now.",
    );
    router.refresh();
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={pending}
        aria-label={
          coupon.isActive
            ? `Switch ${coupon.code} off`
            : `Switch ${coupon.code} on`
        }
        onClick={toggle}
      >
        {coupon.isActive ? (
          <Power className="size-4" />
        ) : (
          <PowerOff className="size-4" />
        )}
      </Button>

      <CouponForm
        coupon={coupon}
        audience={audience}
        triggerLabel={
          <>
            Edit<span className="sr-only"> {coupon.code}</span>
          </>
        }
        triggerVariant="ghost"
      />

      {redemptionCount > 0 ? (
        <span className="text-muted-foreground px-2 text-xs text-pretty">
          Used {redemptionCount} time{redemptionCount === 1 ? "" : "s"} — switch
          it off rather than deleting.
        </span>
      ) : (
        <ConfirmAction
          subject={`Delete ${coupon.code}?`}
          consequence="Nobody has used it, so nothing else changes. This cannot be undone."
          confirmLabel="Delete it"
          triggerLabel={
            <>
              <Trash2 className="size-4" aria-hidden />
              <span className="sr-only">Delete {coupon.code}</span>
            </>
          }
          triggerVariant="ghost"
          triggerSize="icon-sm"
          triggerClassName="text-muted-foreground hover:text-destructive"
          action={() => deleteCoupon({ id: coupon.id })}
          successMessage={`${coupon.code} deleted`}
        />
      )}
    </div>
  );
}
