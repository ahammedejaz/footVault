import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ContactSheet } from "@/components/admin/products/contact-sheet";
import { ImageManager } from "@/components/admin/products/image-manager";
import { ProductForm } from "@/components/admin/products/product-form";
import { RestoreButton } from "@/components/admin/products/restore-button";
import { VariantEditor } from "@/components/admin/products/variant-editor";
import { AdminPage, Chip, PageHeader } from "@/components/admin/ui";
import { LOW_STOCK_THRESHOLD } from "@/lib/queries/admin/dashboard";
import {
  getAdminProduct,
  getCatalogOptions,
  getParcelDefaults,
  listCatalogueImages,
} from "@/lib/queries/admin/products";
import { getAdminSettings } from "@/lib/queries/admin/settings";
import { targetFillFraction } from "@/lib/images/target-fill";

export const dynamic = "force-dynamic";

/** A uuid, or this route is not about a product at all. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  if (!UUID.test(id)) return { title: "Product" };
  const product = await getAdminProduct(id);
  return { title: product ? product.name : "Product" };
}

/**
 * One product: what it is, the sizes it comes in, and its photographs.
 *
 * Three panels rather than three pages, because they are three views of one
 * thing and the owner moves between them constantly — checking a colourway
 * against the photograph, correcting a size after looking at the shelf.
 *
 * A soft-deleted product is still rendered rather than 404'd. It reached this
 * state because `admin_delete_product` found orders against it and hid it
 * instead of dropping it, and a product the owner can neither see nor recover
 * is a product they will assume was destroyed.
 */
export default async function AdminProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // A malformed id would otherwise reach PostgREST as an invalid uuid and
  // surface as a 500 on a URL somebody merely mistyped.
  if (!UUID.test(id)) notFound();

  const [product, { brands, categories }, parcel, settings, sheet] =
    await Promise.all([
      getAdminProduct(id),
      getCatalogOptions(),
      getParcelDefaults(),
      getAdminSettings(),
      listCatalogueImages(),
    ]);

  if (!product) notFound();

  const totalStock = product.variants.reduce(
    (sum, variant) => sum + variant.stock,
    0,
  );

  return (
    <>
      <PageHeader
        title={product.name}
        description={`${product.variants.length} ${product.variants.length === 1 ? "size" : "sizes"} · ${totalStock} in stock · ${product.images.length} ${product.images.length === 1 ? "photograph" : "photographs"}`}
      >
        {product.deletedAt ? (
          <>
            <Chip tone="bad">removed</Chip>
            <RestoreButton id={product.id} name={product.name} />
          </>
        ) : product.isActive ? (
          <Chip tone="good">on the shop</Chip>
        ) : (
          <Chip tone="neutral">hidden</Chip>
        )}
      </PageHeader>

      <AdminPage className="space-y-4">
        {product.deletedAt ? (
          <p className="border-destructive/40 bg-destructive/8 text-pretty rounded-md border px-4 py-3 text-sm">
            This product was deleted. Because it appears on past orders it was
            hidden rather than removed, so those orders still read correctly.
            Putting it back leaves it off the shop until you turn it on.
          </p>
        ) : null}

        <SellableChecklist
          hasPrice={product.basePrice > 0}
          sizes={product.variants.length}
          stock={totalStock}
          photographs={product.images.length}
          isActive={product.isActive}
          isDeleted={product.deletedAt !== null}
        />

        <ProductForm
          product={product}
          brands={brands}
          categories={categories}
          parcel={parcel}
        />

        <VariantEditor
          productId={product.id}
          productName={product.name}
          productSlug={product.slug}
          basePrice={product.basePrice}
          salePrice={product.salePrice}
          variants={product.variants}
          lowStockThreshold={LOW_STOCK_THRESHOLD}
        />

        {/*
          The colourways come from the variants, because that is the only place
          a colourway exists: `product_variants.color` is a text string and the
          storefront matches photographs to swatches by exact equality. Derived
          here rather than inside the manager so the two controls that use it —
          the upload picker and the per-photograph select — cannot end up with
          two different ideas of what this product's colours are.

          Order follows the variant list rather than being sorted, so the names
          appear in the order the owner sees them in the size editor above.
        */}
        <ImageManager
          productId={product.id}
          productName={product.name}
          images={product.images}
          colourways={[...new Set(product.variants.map((v) => v.color))]}
          targetFill={targetFillFraction(settings.images)}
        />

        {/*
          Last on the page, deliberately. It answers a question the owner asks
          *after* framing something — "does this sit with the rest?" — and
          putting a grid of the whole catalogue above the product's own controls
          would bury the thing they came here to edit.
        */}
        <ContactSheet
          images={sheet.images}
          currentProductId={product.id}
          total={sheet.total}
        />
      </AdminPage>
    </>
  );
}

/**
 * What is still standing between this product and a customer being able to buy
 * it.
 *
 * **This exists because "adding a product is complicated" was mostly not about
 * the form.** Creating a product drops the owner onto this page, where three
 * separate panels each hold part of the answer and none of them states the
 * whole: a shoe can have a name, a price, photographs, be switched on, and
 * still be unbuyable because it has no sizes — or have sizes that are all at
 * zero. Working that out meant knowing the rules. Now the page says them.
 *
 * Two deliberate choices about what it does *not* do:
 *
 * It never renders when everything is done. A permanent green "all good" panel
 * is furniture the owner learns to scroll past, and once they are scrolling
 * past it they scroll past the version that had something to say.
 *
 * The last step is worded as an instruction rather than drawn as a button. The
 * publish tick lives in the form below, and a second control that did the same
 * write from a different place is a second thing to keep in step — and would
 * let the owner publish from up here without passing the list of what is
 * missing, which is the one thing this panel is for.
 */
function SellableChecklist({
  hasPrice,
  sizes,
  stock,
  photographs,
  isActive,
  isDeleted,
}: {
  hasPrice: boolean;
  sizes: number;
  stock: number;
  photographs: number;
  isActive: boolean;
  isDeleted: boolean;
}) {
  // A removed product has its own notice directly above, which says something
  // more urgent than this would.
  if (isDeleted) return null;

  const steps = [
    {
      done: hasPrice,
      label: "Give it a price",
      todo: "Set the usual price below. Nothing can be sold without one.",
    },
    {
      done: sizes > 0,
      label: "Add the sizes you have",
      todo: "No sizes yet, so there is nothing for a customer to choose — a shoe with no sizes cannot be bought even when it is on the shop.",
    },
    {
      done: sizes > 0 && stock > 0,
      label: "Put stock against a size",
      todo: "Every size is at zero, so the product page will show it as sold out.",
    },
    {
      done: photographs > 0,
      label: "Add a photograph",
      todo: "The shop will show a blank card until there is at least one.",
    },
    {
      done: isActive,
      label: "Turn it on",
      todo: "It is finished but still hidden. Tick “Customers can see and buy this” in the form below, then save.",
    },
  ];

  const remaining = steps.filter((step) => !step.done);
  if (remaining.length === 0) return null;

  const next = remaining[0];

  return (
    <section
      aria-labelledby="sellable-heading"
      className="border-border bg-muted/40 rounded-md border px-4 py-3"
    >
      <h2 id="sellable-heading" className="text-sm font-semibold">
        {remaining.length === 1
          ? "One thing left before this can sell"
          : `${remaining.length} things left before this can sell`}
      </h2>
      <p className="text-muted-foreground mt-1 max-w-prose text-sm text-pretty">
        <strong className="text-foreground font-medium">{next.label}.</strong>{" "}
        {next.todo}
      </p>
      {remaining.length > 1 ? (
        <ol className="text-muted-foreground mt-2 space-y-0.5 text-sm">
          {remaining.slice(1).map((step) => (
            <li key={step.label}>· {step.label}</li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
