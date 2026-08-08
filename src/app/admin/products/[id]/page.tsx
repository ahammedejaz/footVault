import type { Metadata } from "next";
import { notFound } from "next/navigation";

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
} from "@/lib/queries/admin/products";

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

  const [product, { brands, categories }, parcel] = await Promise.all([
    getAdminProduct(id),
    getCatalogOptions(),
    getParcelDefaults(),
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

        {product.variants.length === 0 ? (
          <p className="border-border bg-muted/50 text-pretty rounded-md border px-4 py-3 text-sm">
            This product has no sizes yet, so nobody can buy it even if it is on
            the shop. Add the sizes you have below.
          </p>
        ) : null}

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

        <ImageManager
          productId={product.id}
          productName={product.name}
          images={product.images}
        />
      </AdminPage>
    </>
  );
}
