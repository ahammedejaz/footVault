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
  /**
   * The variant this chip actually is — the thing add-to-bag needs.
   *
   * Only meaningful inside a colourway, where (product, size, colour) is unique
   * by constraint and so names exactly one row. On a product card the run is
   * the union across colourways, where one chip can stand for three different
   * variants, and there is nothing honest to put here; it is null there, and a
   * quick-add has to resolve a colour before it can act.
   */
  variantId: string | null;
};

export type ProductColor = {
  name: string;
  hex: string | null;
  /** The bucket the colour filter uses: Black, Blue, Brown … See color_family(). */
  family: string | null;
  /** Sizes available in this colourway, so a swatch can narrow the run. */
  sizes: SizeAvailability[];
  /** This colourway's own photography, when it has any. */
  images: ProductImage[];
};

export type ProductImage = { url: string; alt: string; color: string | null };

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
  heroImage: ProductImage | null;
  /** The outsole. The card crossfades to it on hover. */
  soleImage: ProductImage | null;
  sizes: SizeAvailability[];
  colors: ProductColor[];
  inStock: boolean;
  /**
   * Trigger-maintained on `products`, riding PRODUCT_FIELDS — the listing
   * pays zero extra round trips for stars. Sum and count, never a stored
   * average: the average is derived where it is rendered, so the storage
   * stays exact integer arithmetic (Phase 11).
   */
  reviewCount: number;
  ratingSum: number;
};

export type ProductDetail = ProductSummary & {
  description: string | null;
  material: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  images: ProductImage[];
  variants: Array<{
    id: string;
    size: string;
    color: string;
    colorHex: string | null;
    sku: string;
    stock: number;
  }>;
};

/** One filter option and the number of products behind it. */
export type Facet = { value: string; label: string; count: number };

export type CatalogFacets = {
  sizes: Facet[];
  colors: Facet[];
  brands: Facet[];
  genders: Facet[];
  inStock: number;
  onSale: number;
  price: { min: number; max: number } | null;
};

/**
 * The swatch a colour family is drawn with.
 *
 * Deliberately fixed rather than borrowed from the first matching variant: a
 * "Black" chip that renders as #131313 on one listing and #17181c on the next
 * reads as a rendering bug, and a "White" chip drawn from a variant hex would
 * be invisible on paper without a border of its own.
 */
export const COLOR_FAMILY_SWATCH: Record<string, string> = {
  Black: "#111418",
  Grey: "#8b929c",
  White: "#f4f6f8",
  Beige: "#d9c9b0",
  Brown: "#6b4a30",
  Red: "#b32d28",
  Orange: "#e07b1f",
  Yellow: "#e0b91f",
  Green: "#2f6b45",
  Teal: "#1f7d84",
  Blue: "#2a4a80",
  Purple: "#6a4b96",
  Pink: "#d1749a",
};
