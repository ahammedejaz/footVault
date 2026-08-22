"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Pencil, Trash2 } from "lucide-react";

import { ConfirmAction } from "@/components/admin/confirm-action";
import {
  BrandForm,
  type BrandDraft,
} from "@/components/admin/brands/brand-form";
import { Button } from "@/components/ui/button";
import { deleteBrand, setBrandActive } from "@/lib/actions/admin/brands";
import type { SiteImageValue } from "@/lib/images/site-image";
import { toast } from "@/lib/toast";

/**
 * Show/hide, edit and delete for one brand.
 *
 * **Every row offers a delete, and what changes is the sentence attached to
 * it.** This used to render the button only for a brand nothing pointed at, on
 * the argument that a button which always refuses is worse than no button. The
 * argument was sound and the outcome was not: in a real catalogue almost every
 * brand is on something, so almost every row showed a line of prose where the
 * control should have been, and the owner's conclusion — reported in as many
 * words — was that the panel had no way to remove a brand.
 *
 * The third option is the one taken here. The button is always drawn; when
 * products carry the brand it says how many, what they lose (`brand_id` is
 * `on delete set null`, so they are left with no maker — names, prices, sizes
 * and photographs are untouched), and it demands the word typed out before it
 * will fire. Switching the brand off is still the better move nine times in
 * ten, so it is still offered first, in the sentence, where it can be read.
 *
 * This is a Client Component because `ConfirmAction` takes a callback, and a
 * closure cannot cross the Server Component boundary.
 */
export function BrandRowActions({
  brand,
  siteImage = null,
  productCount,
  productCountIncludingHidden,
}: {
  brand: BrandDraft;
  /** Passed straight through to the edit form's logo field. */
  siteImage?: SiteImageValue;
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

      {/*
        An icon, not the word — and the reason is the pinned column this now
        sits in. "Edit" spelled out made the three controls about 300px wide on
        a 390px phone, which left the brand's own name and web address fighting
        over the remaining 90. The eye and the bin either side were already
        icons; matching them buys back roughly half the column and costs
        nothing, because the accessible name still reads "Edit adidas".
      */}
      <BrandForm
        brand={brand}
        siteImage={siteImage}
        triggerLabel={
          <>
            <Pencil className="size-4" aria-hidden />
            <span className="sr-only">Edit {brand.name}</span>
          </>
        }
        triggerVariant="ghost"
        triggerSize="icon-sm"
      />

      <ConfirmAction
        subject={`Delete ${brand.name}?`}
        consequence={
          inUse
            ? `${countPhrase(productCount, productCountIncludingHidden)} will be left with no maker at all. ` +
              `Everything else about ${productCount === 1 ? "it" : "them"} — name, price, sizes, photographs — is untouched, ` +
              `and you can set a maker again one at a time. If you only want ${brand.name} out of the shop's filters, ` +
              `close this and use the eye instead. This cannot be undone.`
            : "No product is using it, so nothing else changes. This cannot be undone."
        }
        confirmLabel={inUse ? "Delete it anyway" : "Delete it"}
        triggerLabel={
          <>
            <Trash2 className="size-4" aria-hidden />
            <span className="sr-only">Delete {brand.name}</span>
          </>
        }
        triggerVariant="ghost"
        triggerSize="icon-sm"
        triggerClassName="text-muted-foreground hover:text-destructive"
        // Typed only when something is actually lost. Asking for it on the
        // harmless case teaches the owner to type it without reading, which is
        // the one habit that makes the guard on the harmful case worthless.
        requireTyping={inUse ? "delete" : undefined}
        action={() => deleteBrand({ id: brand.id, force: inUse })}
        successMessage={
          inUse
            ? `${brand.name} deleted — ${productCountIncludingHidden} product${productCountIncludingHidden === 1 ? "" : "s"} now have no maker`
            : `${brand.name} deleted`
        }
      />
    </div>
  );
}

/**
 * "3 products", or "1 product (and 2 removed ones)".
 *
 * The two counts differ when a soft-deleted product still carries the brand,
 * and the difference matters: the owner can see the live ones on
 * `/admin/products` and cannot see the others anywhere, so a single number
 * would be a number they are unable to check. The removed ones are the reason
 * the delete is destructive at all — they come back unbranded if restored.
 */
function countPhrase(live: number, total: number): string {
  const hidden = total - live;
  if (live === 0) {
    return `${hidden} removed product${hidden === 1 ? "" : "s"} still carrying it`;
  }
  const head = `${live} product${live === 1 ? "" : "s"}`;
  return hidden > 0 ? `${head} (and ${hidden} removed)` : head;
}
