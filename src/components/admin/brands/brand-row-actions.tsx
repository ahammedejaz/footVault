"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Trash2 } from "lucide-react";

import { ConfirmAction } from "@/components/admin/confirm-action";
import {
  BrandForm,
  type BrandDraft,
} from "@/components/admin/brands/brand-form";
import { Button } from "@/components/ui/button";
import { deleteBrand, setBrandActive } from "@/lib/actions/admin/brands";
import { toast } from "@/lib/toast";

/**
 * Show/hide, edit and delete for one brand.
 *
 * **The delete button is only rendered when deleting is possible.**
 * `products.brand_id` is `on delete set null`, so removing a brand that is in
 * use silently strips the maker off every product carrying it — the action
 * refuses, and offering a red button that always refuses is worse than not
 * offering one. In its place the row says what to do instead, which is almost
 * always to switch the brand off: that takes it out of the shop's filters and
 * leaves the products alone.
 *
 * This is a Client Component because `ConfirmAction` takes a callback, and a
 * closure cannot cross the Server Component boundary.
 */
export function BrandRowActions({
  brand,
  productCount,
  productCountIncludingHidden,
}: {
  brand: BrandDraft;
  /** Live products. What the copy quotes, because it is what the owner sees. */
  productCount: number;
  /** Including soft-deleted ones. What actually blocks the delete. */
  productCountIncludingHidden: number;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  const inUse = productCountIncludingHidden > 0;

  async function toggle() {
    setPending(true);
    const result = await setBrandActive({
      id: brand.id,
      isActive: !brand.isActive,
    });
    setPending(false);
    if (!result.ok) {
      toast.failed(result.message);
      return;
    }
    toast.done(
      brand.isActive ? `${brand.name} is hidden` : `${brand.name} is showing`,
      brand.isActive
        ? "It has gone from the shop's filters. Its products are unaffected."
        : "Customers can filter by it again.",
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
          brand.isActive
            ? `Hide ${brand.name} from the shop`
            : `Show ${brand.name} in the shop`
        }
        onClick={toggle}
      >
        {brand.isActive ? (
          <Eye className="size-4" />
        ) : (
          <EyeOff className="size-4" />
        )}
      </Button>

      <BrandForm
        brand={brand}
        triggerLabel={
          <>
            Edit<span className="sr-only"> {brand.name}</span>
          </>
        }
        triggerVariant="ghost"
      />

      {inUse ? (
        <span className="text-muted-foreground px-2 text-xs text-pretty">
          {productCount > 0
            ? `On ${productCount} product${productCount === 1 ? "" : "s"} — switch it off rather than deleting.`
            : "Used by a hidden product — switch it off rather than deleting."}
        </span>
      ) : (
        <ConfirmAction
          subject={`Delete ${brand.name}?`}
          consequence="No product is using it, so nothing else changes. This cannot be undone."
          confirmLabel="Delete it"
          triggerLabel={
            <>
              <Trash2 className="size-4" aria-hidden />
              <span className="sr-only">Delete {brand.name}</span>
            </>
          }
          triggerVariant="ghost"
          triggerSize="icon-sm"
          triggerClassName="text-muted-foreground hover:text-destructive"
          action={() => deleteBrand({ id: brand.id })}
          successMessage={`${brand.name} deleted`}
        />
      )}
    </div>
  );
}
