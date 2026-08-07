import type { Metadata } from "next";

import { Breadcrumbs } from "@/components/storefront/breadcrumbs";
import { ProductListing } from "@/components/storefront/product-listing";
import type { RawSearchParams } from "@/lib/queries/search-params";

export const metadata: Metadata = {
  title: "All footwear",
  description:
    "Every shoe we hold, in every size we hold it. Sneakers, formal shoes, boots, sports shoes and sandals for men, women and kids.",
  alternates: { canonical: "/shop" },
};

export default async function ShopPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  return (
    <>
      <div className="mx-auto max-w-7xl px-4 pt-6 sm:px-6">
        <Breadcrumbs crumbs={[{ label: "Home", href: "/" }, { label: "All footwear" }]} />
      </div>
      <ProductListing
        params={params}
        pathname="/shop"
        heading="All footwear"
        description="Every size we hold is printed on every card. Struck through means sold out, not hidden."
      />
    </>
  );
}
