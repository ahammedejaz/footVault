"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink } from "lucide-react";

import { Disclosure, Panel } from "@/components/admin/ui";
import { describedBy, Field } from "@/components/admin/products/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { saveProduct } from "@/lib/actions/admin/products";
import { formatRupees } from "@/lib/format";
import { toast } from "@/lib/toast";
import {
  FOOTWEAR_LABEL,
  FOOTWEAR_TYPES,
  GENDER_LABEL,
  GENDERS,
  slugify,
  type AdminProductDetail,
  type CatalogOption,
  type FootwearType,
  type Gender,
  type ParcelDefaults,
} from "@/components/admin/products/types";

/**
 * The product form, for both creating and editing.
 *
 * **Everything is a string in state, including the numbers.** A price field
 * bound to a `number` cannot hold the empty string, so clearing it snaps to 0 —
 * and a shoe momentarily priced at zero is one mis-timed save away from being a
 * shoe actually priced at zero. The conversion happens once, on submit, where
 * an unparseable value is a message rather than a silent coercion.
 *
 * Server errors are keyed by the field they came from: `AdminFailure` carries
 * the Zod issue path, so "that SKU is taken" lands under the SKU box and takes
 * focus, rather than appearing as a toast the owner has to map back onto a form
 * with twenty inputs.
 *
 * ## Two shapes, and why creating shows less than editing
 *
 * `/admin/products/new` has always described itself as asking "only for what a
 * product cannot exist without", and it was not true: it rendered this
 * component, and this component rendered all five panels. So adding a shoe
 * opened with twenty-odd fields — parcel dimensions, a search title, a search
 * description, extra search words, two publish checkboxes — of which three
 * matter and the rest have working defaults. The owner's report was that adding
 * a product is complicated. It was.
 *
 * Creating now renders **the basics and the price**, and nothing else. The
 * fields left out are exactly the ones with a defensible default: parcel size
 * falls back to the shop's usual box, every search field falls back to the
 * product's own name and description, and `is_active` starts false on purpose
 * (see `draftFrom`) because a product with no sizes and no photographs must not
 * be buyable. None of them is a decision the owner is in a position to make
 * before the shoe exists.
 *
 * Editing renders everything, with those same two groups behind a `Disclosure`
 * so the page opens on what is usually being changed. The disclosures are
 * closed rather than absent because "where did the parcel size go" is a support
 * call and a summary line is not.
 */

type Draft = {
  name: string;
  slug: string;
  description: string;
  brandId: string;
  categoryId: string;
  gender: Gender;
  footwearType: FootwearType;
  material: string;
  basePrice: string;
  salePrice: string;
  isActive: boolean;
  isFeatured: boolean;
  metaTitle: string;
  metaDescription: string;
  weightGrams: string;
  lengthCm: string;
  breadthCm: string;
  heightCm: string;
  searchKeywords: string;
};

/** Paise in the database, rupees in the box. `null` stays empty, not "0". */
function rupees(paise: number | null): string {
  return paise === null ? "" : String(paise / 100);
}

function text(value: string | null): string {
  return value ?? "";
}

function draftFrom(product: AdminProductDetail | null): Draft {
  return {
    name: product?.name ?? "",
    slug: product?.slug ?? "",
    description: text(product?.description ?? null),
    brandId: product?.brandId ?? "",
    categoryId: product?.categoryId ?? "",
    gender: product?.gender ?? "unisex",
    footwearType: product?.footwearType ?? "sneaker",
    material: text(product?.material ?? null),
    basePrice: rupees(product?.basePrice ?? null),
    salePrice: rupees(product?.salePrice ?? null),
    // A new product starts hidden. The owner adds sizes and photographs after
    // this form, and publishing first means a spell where the shop shows a pair
    // in no size with no picture.
    isActive: product?.isActive ?? false,
    isFeatured: product?.isFeatured ?? false,
    metaTitle: text(product?.metaTitle ?? null),
    metaDescription: text(product?.metaDescription ?? null),
    weightGrams:
      product?.weightGrams === null ? "" : String(product?.weightGrams ?? ""),
    lengthCm: product?.lengthCm === null ? "" : String(product?.lengthCm ?? ""),
    breadthCm:
      product?.breadthCm === null ? "" : String(product?.breadthCm ?? ""),
    heightCm: product?.heightCm === null ? "" : String(product?.heightCm ?? ""),
    searchKeywords: (product?.searchKeywords ?? []).join(", "),
  };
}

type Errors = Partial<Record<string, string>>;

export function ProductForm({
  product,
  brands,
  categories,
  parcel,
}: {
  product: AdminProductDetail | null;
  brands: CatalogOption[];
  categories: CatalogOption[];
  parcel: ParcelDefaults;
}) {
  const router = useRouter();
  const [draft, setDraft] = React.useState<Draft>(() => draftFrom(product));
  const [errors, setErrors] = React.useState<Errors>({});
  const [pending, setPending] = React.useState(false);
  /**
   * Whether the owner has taken the web address into their own hands. Until
   * they do, it follows the name — which is what they expect, and which stops
   * every product being called `untitled-2`. Once they edit it, it is theirs:
   * a slug that keeps rewriting itself under a rename is how a live product
   * page silently changes address.
   */
  const [slugTouched, setSlugTouched] = React.useState(product !== null);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [fieldKey(key)]: undefined }));
  }

  const base = decimal(draft.basePrice);
  const sale = decimal(draft.salePrice);
  const customerPays = sale ?? base;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const next: Errors = {};
    if (!draft.name.trim()) next.name = "Give the product a name.";
    if (!draft.slug.trim()) next.slug = "Give it a web address.";
    if (base === null || base <= 0) {
      next.basePriceRupees = "Give it a price the customer pays.";
    }
    if (draft.salePrice.trim() && sale === null) {
      next.salePriceRupees =
        "That is not a number. Leave it blank for no sale.";
    }
    if (Object.keys(next).length > 0) {
      setErrors(next);
      focusFirst(next);
      return;
    }

    setPending(true);
    const result = await saveProduct({
      id: product?.id,
      name: draft.name,
      slug: draft.slug,
      description: draft.description,
      brandId: draft.brandId,
      categoryId: draft.categoryId,
      gender: draft.gender,
      footwearType: draft.footwearType,
      material: draft.material,
      basePriceRupees: base,
      salePriceRupees: sale,
      isActive: draft.isActive,
      isFeatured: draft.isFeatured,
      metaTitle: draft.metaTitle,
      metaDescription: draft.metaDescription,
      weightGrams: integer(draft.weightGrams),
      lengthCm: decimal(draft.lengthCm),
      breadthCm: decimal(draft.breadthCm),
      heightCm: decimal(draft.heightCm),
      searchKeywords: draft.searchKeywords
        .split(",")
        .map((word) => word.trim())
        .filter(Boolean),
    });
    setPending(false);

    if (!result.ok) {
      const field = "field" in result ? result.field : undefined;
      if (field) {
        setErrors({ [field]: result.message });
        focusFirst({ [field]: result.message });
      } else {
        toast.failed(result.message);
      }
      return;
    }

    if (result.created) {
      toast.done(
        `${draft.name} has been created`,
        "Now add the sizes you have and at least one photograph.",
      );
      router.push(`/admin/products/${result.id}`);
      return;
    }

    toast.done(`${draft.name} has been saved`, "The shop has it already.");
    router.refresh();
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Panel
        title="The basics"
        description="What it is called, where it sits in the shop, and what it is made of."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            htmlFor={id("name")}
            label="Name"
            required
            error={errors.name}
            className="sm:col-span-2"
          >
            <Input
              id={id("name")}
              value={draft.name}
              onChange={(event) => {
                const value = event.target.value;
                set("name", value);
                if (!slugTouched) {
                  setDraft((current) => ({ ...current, slug: slugify(value) }));
                }
              }}
              placeholder="Nike Air Max 90"
              autoComplete="off"
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={describedBy(id("name"), {
                error: errors.name,
                hint: false,
              })}
            />
          </Field>

          <Field
            htmlFor={id("slug")}
            label="Web address"
            required
            error={errors.slug}
            hint={
              draft.slug
                ? `The shop will show it at /product/${draft.slug}`
                : "Lowercase letters, numbers and hyphens."
            }
            className="sm:col-span-2"
          >
            <Input
              id={id("slug")}
              value={draft.slug}
              onChange={(event) => {
                setSlugTouched(true);
                set("slug", event.target.value);
              }}
              onBlur={(event) => set("slug", slugify(event.target.value))}
              placeholder="nike-air-max-90"
              autoComplete="off"
              className="font-mono"
              aria-invalid={errors.slug ? true : undefined}
              aria-describedby={describedBy(id("slug"), {
                error: errors.slug,
                hint: true,
              })}
            />
          </Field>

          <Field htmlFor={id("brandId")} label="Brand" error={errors.brandId}>
            <Select
              id={id("brandId")}
              value={draft.brandId}
              onChange={(event) => set("brandId", event.target.value)}
              aria-describedby={describedBy(id("brandId"), {
                error: errors.brandId,
                hint: false,
              })}
            >
              <option value="">No brand</option>
              {brands.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.name}
                  {brand.isActive ? "" : " (hidden)"}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            htmlFor={id("categoryId")}
            label="Category"
            error={errors.categoryId}
          >
            <Select
              id={id("categoryId")}
              value={draft.categoryId}
              onChange={(event) => set("categoryId", event.target.value)}
              aria-describedby={describedBy(id("categoryId"), {
                error: errors.categoryId,
                hint: false,
              })}
            >
              <option value="">No category</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                  {category.isActive ? "" : " (hidden)"}
                </option>
              ))}
            </Select>
          </Field>

          <Field htmlFor={id("gender")} label="Who it is for">
            <Select
              id={id("gender")}
              value={draft.gender}
              onChange={(event) => set("gender", event.target.value as Gender)}
            >
              {GENDERS.map((value) => (
                <option key={value} value={value}>
                  {GENDER_LABEL[value]}
                </option>
              ))}
            </Select>
          </Field>

          <Field htmlFor={id("footwearType")} label="Kind of footwear">
            <Select
              id={id("footwearType")}
              value={draft.footwearType}
              onChange={(event) =>
                set("footwearType", event.target.value as FootwearType)
              }
            >
              {FOOTWEAR_TYPES.map((value) => (
                <option key={value} value={value}>
                  {FOOTWEAR_LABEL[value]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            htmlFor={id("material")}
            label="Material"
            hint="Shown on the product page. Leather, mesh, canvas."
          >
            <Input
              id={id("material")}
              value={draft.material}
              onChange={(event) => set("material", event.target.value)}
              placeholder="Leather upper, rubber sole"
              autoComplete="off"
              aria-describedby={describedBy(id("material"), { hint: true })}
            />
          </Field>

          <Field
            htmlFor={id("description")}
            label="Description"
            className="sm:col-span-2"
            hint="A short paragraph. The first sentence is used as the search description if you leave that blank."
          >
            <textarea
              id={id("description")}
              value={draft.description}
              onChange={(event) => set("description", event.target.value)}
              rows={5}
              className="border-input focus-visible:ring-ring w-full rounded-lg border bg-transparent px-3 py-2 text-base"
              aria-describedby={describedBy(id("description"), { hint: true })}
            />
          </Field>
        </div>
      </Panel>

      <Panel
        title="Price"
        description="Both figures are in rupees. A sale price has to be below the usual one."
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            htmlFor={id("basePriceRupees")}
            label="Usual price"
            required
            error={errors.basePriceRupees}
          >
            <Input
              id={id("basePriceRupees")}
              value={draft.basePrice}
              onChange={(event) => set("basePrice", event.target.value)}
              inputMode="decimal"
              placeholder="8995"
              autoComplete="off"
              className="font-mono tabular-nums"
              aria-invalid={errors.basePriceRupees ? true : undefined}
              aria-describedby={describedBy(id("basePriceRupees"), {
                error: errors.basePriceRupees,
                hint: false,
              })}
            />
          </Field>

          <Field
            htmlFor={id("salePriceRupees")}
            label="Sale price"
            error={errors.salePriceRupees}
            hint="Leave blank when it is not on sale."
          >
            <Input
              id={id("salePriceRupees")}
              value={draft.salePrice}
              onChange={(event) => set("salePrice", event.target.value)}
              inputMode="decimal"
              placeholder="—"
              autoComplete="off"
              className="font-mono tabular-nums"
              aria-invalid={errors.salePriceRupees ? true : undefined}
              aria-describedby={describedBy(id("salePriceRupees"), {
                error: errors.salePriceRupees,
                hint: true,
              })}
            />
          </Field>

          <div className="self-end pb-1">
            <p className="text-muted-foreground text-xs">The customer pays</p>
            <p
              className="text-lg font-semibold tabular-nums"
              aria-live="polite"
            >
              {customerPays === null || customerPays <= 0
                ? "—"
                : formatRupees(customerPays)}
            </p>
          </div>
        </div>
      </Panel>

      {/*
        Everything from here to the submit bar is edit-only. See the note at the
        top of this file: none of it is a decision the owner can make before the
        shoe exists, and all of it has a default that works.
      */}
      {product === null ? null : (
        <Disclosure
          title="Parcel size"
          hint={`What the courier is told this pair weighs and measures. Left alone, the shop's usual box is used — ${parcel.weightGrams}g, ${parcel.lengthCm} × ${parcel.breadthCm} × ${parcel.heightCm} cm.`}
        >
          <p className="text-muted-foreground mb-3 max-w-prose text-sm text-pretty">
            Delivery is priced live by Shiprocket against these numbers. Leave
            any of them blank and the shop default is used instead —{" "}
            <strong className="text-foreground font-medium tabular-nums">
              {parcel.weightGrams}g, {parcel.lengthCm} × {parcel.breadthCm} ×{" "}
              {parcel.heightCm} cm
            </strong>{" "}
            — which is right for most shoe boxes. Fill them in for anything
            noticeably heavier or bulkier, like boots, so the quote matches what
            the courier actually charges.
          </p>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field
              htmlFor={id("weightGrams")}
              label="Weight"
              hint="Grams, boxed"
              error={errors.weightGrams}
            >
              <Input
                id={id("weightGrams")}
                value={draft.weightGrams}
                onChange={(event) => set("weightGrams", event.target.value)}
                inputMode="numeric"
                placeholder={String(parcel.weightGrams)}
                autoComplete="off"
                className="font-mono tabular-nums"
                aria-invalid={errors.weightGrams ? true : undefined}
                aria-describedby={describedBy(id("weightGrams"), {
                  error: errors.weightGrams,
                  hint: true,
                })}
              />
            </Field>
            <DimensionField
              name="lengthCm"
              label="Length"
              value={draft.lengthCm}
              fallback={parcel.lengthCm}
              error={errors.lengthCm}
              onChange={(value) => set("lengthCm", value)}
            />
            <DimensionField
              name="breadthCm"
              label="Breadth"
              value={draft.breadthCm}
              fallback={parcel.breadthCm}
              error={errors.breadthCm}
              onChange={(value) => set("breadthCm", value)}
            />
            <DimensionField
              name="heightCm"
              label="Height"
              value={draft.heightCm}
              fallback={parcel.heightCm}
              error={errors.heightCm}
              onChange={(value) => set("heightCm", value)}
            />
          </div>
        </Disclosure>
      )}

      {product === null ? null : (
        <Disclosure
          title="How it is found"
          hint="What Google shows, and the words a customer might search that your description does not use. Left alone, the product's own name and description are used."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              htmlFor={id("metaTitle")}
              label="Search title"
              error={errors.metaTitle}
              hint={`${draft.metaTitle.length}/70 characters. Blank uses the product name.`}
            >
              <Input
                id={id("metaTitle")}
                value={draft.metaTitle}
                onChange={(event) => set("metaTitle", event.target.value)}
                maxLength={70}
                autoComplete="off"
                aria-invalid={errors.metaTitle ? true : undefined}
                aria-describedby={describedBy(id("metaTitle"), {
                  error: errors.metaTitle,
                  hint: true,
                })}
              />
            </Field>

            <Field
              htmlFor={id("searchKeywords")}
              label="Extra search words"
              hint="Separated by commas. Add what a customer would type — chappal, running, gym."
            >
              <Input
                id={id("searchKeywords")}
                value={draft.searchKeywords}
                onChange={(event) => set("searchKeywords", event.target.value)}
                placeholder="running, gym, trainer"
                autoComplete="off"
                aria-describedby={describedBy(id("searchKeywords"), {
                  hint: true,
                })}
              />
            </Field>

            <Field
              htmlFor={id("metaDescription")}
              label="Search description"
              className="sm:col-span-2"
              error={errors.metaDescription}
              hint={`${draft.metaDescription.length}/200 characters. Blank uses the first sentence of the description.`}
            >
              <textarea
                id={id("metaDescription")}
                value={draft.metaDescription}
                onChange={(event) => set("metaDescription", event.target.value)}
                maxLength={200}
                rows={3}
                className="border-input focus-visible:ring-ring w-full rounded-lg border bg-transparent px-3 py-2 text-base"
                aria-invalid={errors.metaDescription ? true : undefined}
                aria-describedby={describedBy(id("metaDescription"), {
                  error: errors.metaDescription,
                  hint: true,
                })}
              />
            </Field>
          </div>
        </Disclosure>
      )}

      {product === null ? null : (
        <Panel title="On the shop">
          <div className="space-y-2">
            <CheckRow
              id={id("isActive")}
              checked={draft.isActive}
              onChange={(value) => set("isActive", value)}
              label="Customers can see and buy this"
              hint="Turn it off to take it down without deleting anything."
            />
            <CheckRow
              id={id("isFeatured")}
              checked={draft.isFeatured}
              onChange={(value) => set("isFeatured", value)}
              label="Feature it"
              hint="Eligible for the featured rail on the homepage."
            />
          </div>
        </Panel>
      )}

      {/*
        What happens next, said before the button rather than after it.

        Creating a product lands the owner on its edit page with three empty
        panels and no statement of what is still required — which is the point
        at which "adding a product is complicated" gets said. Two sentences here
        cost nothing and set the expectation that this form is step one of
        three.
      */}
      {product === null ? (
        <p className="border-border bg-muted/40 max-w-prose rounded-md border px-4 py-3 text-sm text-pretty">
          Next come the sizes you have and at least one photograph, on this
          product&rsquo;s own page. It stays off the shop until you turn it on
          there, so nothing is visible to customers in the meantime.
        </p>
      ) : null}

      {/* Sticky, because this form is longer than a tablet screen and hunting
          for the save button after every edit is the panel's most-repeated
          annoyance. `-mx` pulls it to the full width of the content well. */}
      <div className="bg-background border-border sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3 sm:-mx-6 sm:px-6">
        {product ? (
          <Link
            href={`/product/${product.slug}`}
            target="_blank"
            rel="noreferrer"
            className="text-orange-ink mr-auto inline-flex min-h-11 items-center gap-1.5 text-sm underline-offset-4 hover:underline"
          >
            See it on the shop
            <ExternalLink className="size-4" aria-hidden />
          </Link>
        ) : null}
        <Button variant="outline" size="sm" asChild>
          <Link href="/admin/products">Back to products</Link>
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {pending
            ? "Saving…"
            : product
              ? "Save changes"
              : "Create the product"}
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ parts -- */

function DimensionField({
  name,
  label,
  value,
  fallback,
  error,
  onChange,
}: {
  name: string;
  label: string;
  value: string;
  fallback: number;
  error?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field htmlFor={id(name)} label={label} hint="Centimetres" error={error}>
      <Input
        id={id(name)}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode="decimal"
        placeholder={String(fallback)}
        autoComplete="off"
        className="font-mono tabular-nums"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id(name), { error, hint: true })}
      />
    </Field>
  );
}

function CheckRow({
  id: inputId,
  checked,
  onChange,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 py-1">
      <input
        id={inputId}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-foreground mt-0.5 size-5 cursor-[inherit]"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="text-muted-foreground block text-xs text-pretty">
          {hint}
        </span>
      </span>
    </label>
  );
}

/* --------------------------------------------------------------- plumbing -- */

/** Stable ids, so the submit handler can turn a Zod path back into an element. */
function id(name: string): string {
  return `product-${name}`;
}

function fieldKey(key: string): string {
  if (key === "basePrice") return "basePriceRupees";
  if (key === "salePrice") return "salePriceRupees";
  return key;
}

function focusFirst(errors: Errors): void {
  const first = Object.keys(errors).find((key) => errors[key]);
  if (!first) return;
  const element = document.getElementById(id(first));
  if (element instanceof HTMLElement) element.focus();
}

/** Empty is null, garbage is null. Never NaN — that does not survive a POST. */
function decimal(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value: string): number | null {
  const parsed = decimal(value);
  return parsed === null ? null : Math.round(parsed);
}
