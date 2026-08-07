import type { Metadata } from "next";

import { ProductListing } from "@/components/storefront/product-listing";
import type { RawSearchParams } from "@/lib/queries/search-params";

export const metadata: Metadata = {
  title: "All footwear",
  description:
    "Every shoe we hold, in every size we hold it. Sneakers, formal shoes, boots, sports shoes and sandals for men, women and kids.",
};

export const revalidate = 600;

export default async function ShopPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  return (
    <ProductListing
      params={params}
      pathname="/shop"
      title="All footwear"
      description="Every size we hold is printed on every card. Struck through means sold out, not hidden."
    />
  );
}
