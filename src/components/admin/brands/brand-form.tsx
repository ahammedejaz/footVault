"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { SiteImageField } from "@/components/admin/site-images/site-image-field";
import { FieldLabel } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createBrand, updateBrand } from "@/lib/actions/admin/brands";
import { slotFor, type SiteImageValue } from "@/lib/images/site-image";
import { toast } from "@/lib/toast";

/**
 * Adding and editing a maker.
 *
 * Same two-in-one form as the category dialog, for the same reason: two copies
 * drift. The web address follows the name while adding and never while editing,
 * because `?brand=nike` is in links the owner has already shared.
 *
 * **The logo preview is a plain `<img>`, not `next/image`.** The optimiser only
 * serves hosts named in `next.config.ts` — currently just this project's own
 * Supabase storage — so a pasted address from anywhere else would render as a
 * broken optimiser response rather than as the picture the owner just chose.
 * An unoptimised 40px thumbnail on an admin screen costs nothing and tells the
 * truth about whether the address works.
 */

export type BrandDraft = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  isActive: boolean;
};

export function BrandForm({
  brand,
  siteImage = null,
  triggerLabel,
  triggerVariant = "outline",
  triggerSize = "sm",
}: {
  /** Absent when adding. */
  brand?: BrandDraft;
  /**
   * The stored original and framing for this maker's mark, so Adjust works
   * without a re-upload. Always null while adding: a picture is filed under a
   * slot named after the row's id, and a row being created has none.
   */
  siteImage?: SiteImageValue;
  triggerLabel: React.ReactNode;
  triggerVariant?: "default" | "outline" | "ghost" | "secondary";
  triggerSize?: "sm" | "default" | "icon-sm";
}) {
  const router = useRouter();
  const editing = brand !== undefined;

  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState(brand?.name ?? "");
  const [slug, setSlug] = React.useState(brand?.slug ?? "");
  const [slugTouched, setSlugTouched] = React.useState(editing);
  const [logoUrl, setLogoUrl] = React.useState(brand?.logoUrl ?? "");
  const [isActive, setIsActive] = React.useState(brand?.isActive ?? true);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const fieldId = React.useId();

  function reset() {
    setName(brand?.name ?? "");
    setSlug(brand?.slug ?? "");
    setSlugTouched(editing);
    setLogoUrl(brand?.logoUrl ?? "");
    setIsActive(brand?.isActive ?? true);
    setError(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const payload = {
      name,
      slug: slug || slugify(name),
      logoUrl: logoUrl.trim() ? logoUrl.trim() : null,
      isActive,
    };
    const result = editing
      ? await updateBrand({ ...payload, id: brand.id })
      : await createBrand(payload);
    setPending(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    setOpen(false);
    if (!editing) reset();
    toast.done(
      editing ? `${name} saved` : `${name} added`,
      editing ? undefined : "Products can be filed under it now.",
    );
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        // Reset on the way in as well as out — see the note in CategoryForm.
        reset();
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant={triggerVariant} size={triggerSize}>
          {triggerLabel}
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-pretty">
            {editing ? `Edit ${brand.name}` : "Add a brand"}
          </DialogTitle>
          <DialogDescription className="text-pretty">
            Brands are what customers filter the shop by. Every product can name
            one.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <FieldLabel htmlFor={`${fieldId}-name`} required>
              Name
            </FieldLabel>
            <Input
              id={`${fieldId}-name`}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (!slugTouched) setSlug(slugify(event.target.value));
              }}
              placeholder="Nike"
              maxLength={60}
              required
              autoComplete="off"
              disabled={pending}
            />
          </div>

          <div>
            <FieldLabel
              htmlFor={`${fieldId}-slug`}
              required
              hint={
                editing
                  ? "Changing this breaks any /shop?brand= link already shared."
                  : "Used in the shop's filters: /shop?brand=nike"
              }
            >
              Web address
            </FieldLabel>
            <Input
              id={`${fieldId}-slug`}
              value={slug}
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(event.target.value);
              }}
              placeholder="nike"
              maxLength={60}
              required
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-sm"
              disabled={pending}
            />
          </div>

          {/*
            The logo was a text box you pasted a storage URL into, with the
            instruction "upload the picture on the Media screen, then paste its
            address here". Every brand on this shop has a null logo, which is
            what that instruction is worth: a field that works is not the same
            as a field anybody can use.

            The address field is gone rather than kept alongside. Two ways to
            set the same value is how one of them goes stale, and the pasted
            address had no framing behind it — so a logo set that way could
            never be adjusted, only replaced.
          */}
          {editing ? (
            <SiteImageField
              slot={slotFor.brand(brand.id)}
              frame="brand_logo"
              initial={siteImage}
              disabled={pending}
              hint="Optional. Shown on this maker's products and on the brand list. Artwork with a transparent background sits best on the page."
              showAlt={false}
              onChange={(url) => setLogoUrl(url ?? "")}
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              Add the brand first — its logo can be chosen as soon as it exists.
            </p>
          )}

          <label className="flex min-h-11 items-center gap-2.5">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
              disabled={pending}
              className="accent-foreground size-5"
            />
            <span className="text-sm">
              Show it in the shop
              <span className="text-muted-foreground block text-xs">
                Switched off, it drops out of the shop&rsquo;s filters. Its
                products stay listed.
              </span>
            </span>
          </label>

          {error ? (
            <p className="text-destructive text-sm text-pretty" role="alert">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending || !name.trim()}>
              {pending ? "Saving…" : editing ? "Save" : "Add it"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Mirrors what the action's schema will accept, so the field never fails it. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
