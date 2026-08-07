import type { Database } from "@/lib/database.types";

/**
 * The catalog's view models.
 *
 * These live apart from src/lib/queries/catalog.ts, which is marked
 * `server-only`, so that a Client Component can name the shape it renders
 * without importing a module that must never reach the browser. A type-only
 * import would be erased anyway, but "would be erased" depends on the import
 * staying type-only — and one careless edit is all it takes. Keeping the types
 * in a file with no server dependency removes the question.
 */

export type Gender = Database["public"]["Enums"]["gender_group"];
export type FootwearType = Database["public"]["Enums"]["footwear_type"];

export type SizeAvailability = {
  size: string;
  available: boolean;
  /** Units left across every colourway. Drives "Only 2 left in size 9". */
  stock: number;
};

export type ProductColor = { name: string; hex: string | null };

export type ProductSummary = {
  id: string;
  slug: string;
  name: string;
  brandName: string | null;
  categoryName: string | null;
  categorySlug: string | null;
  gender: Gender;
  footwearType: FootwearType;
  basePrice: number;
  salePrice: number | null;
  /** Three-quarter view. Every product has one; the seed guarantees it. */
  heroImage: { url: string; alt: string } | null;
  /** The outsole. The card crossfades to it on hover. */
  soleImage: { url: string; alt: string } | null;
  sizes: SizeAvailability[];
  colors: ProductColor[];
  inStock: boolean;
};

export type ProductDetail = ProductSummary & {
  description: string | null;
  material: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  images: Array<{ url: string; alt: string }>;
  variants: Array<{
    id: string;
    size: string;
    color: string;
    colorHex: string | null;
    sku: string;
    stock: number;
  }>;
};
