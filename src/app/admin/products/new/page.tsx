import type { Metadata } from "next";
import Link from "next/link";

import { ProductForm } from "@/components/admin/products/product-form";
import { AdminPage, PageHeader } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import {
  getCatalogOptions,
  getParcelDefaults,
} from "@/lib/queries/admin/products";

export const metadata: Metadata = { title: "Add a product" };
export const dynamic = "force-dynamic";

/**
 * A new product, in two steps rather than one.
 *
 * This page asks only for what a product cannot exist without — a name, a web
 * address and a price — and hands the owner straight to the edit page, where
 * sizes and photographs live. A single form carrying all three would be a page
 * that cannot be saved until every part of it is right, and the owner does not
 * always have the photographs when they have the shoes.
 *
 * The product is created **off** the shop for the same reason: between saving
 * this form and adding a size there is a window in which the product exists,
 * has no sizes, and cannot be bought. Publishing is a separate tick.
 */
export default async function NewProductPage() {
  const [{ brands, categories }, parcel] = await Promise.all([
    getCatalogOptions(),
    getParcelDefaults(),
  ]);

  return (
    <>
      <PageHeader
        title="Add a product"
        description="Name it and price it. Sizes and photographs come next, on its own page."
      >
        <Button variant="outline" size="sm" asChild>
          <Link href="/admin/products">Cancel</Link>
        </Button>
      </PageHeader>

      <AdminPage>
        <ProductForm
          product={null}
          brands={brands}
          categories={categories}
          parcel={parcel}
        />
      </AdminPage>
    </>
  );
}
