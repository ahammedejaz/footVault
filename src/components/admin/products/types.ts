import type { FootwearType, Gender } from "@/lib/catalog-types";

/**
 * The product screens' view models, and the shape the form posts back.
 *
 * They live here, next to the components that render them, rather than in
 * `@/lib/queries/admin/products` — that module is `server-only`, and the form,
 * the variant editor and the image manager are all Client Components. A
 * `import type` from a server module is erased and so builds happily, which is
 * exactly why it is the wrong place to put the boundary: the next edit that
 * needs one more thing turns it into a value import and drags a service-role
 * client into the browser bundle. `src/lib/inventory-types.ts` exists for the
 * same reason and says so at greater length.
 */

export type { FootwearType, Gender } from "@/lib/catalog-types";

/**
 * Tuples rather than arrays, because `z.enum()` needs a non-empty tuple and
 * because the order here is the order the owner sees in the select.
 */
export const GENDERS = [
  "men",
  "women",
  "unisex",
  "kids",
] as const satisfies readonly Gender[];

export const FOOTWEAR_TYPES = [
  "sneaker",
  "sports",
  "formal",
  "boot",
  "sandal",
  "slide",
  "flipflop",
] as const satisfies readonly FootwearType[];

/** What the owner would call each one. `flipflop` is not a word on a shelf. */
export const FOOTWEAR_LABEL: Record<FootwearType, string> = {
  sneaker: "Sneaker",
  sports: "Sports shoe",
  formal: "Formal",
  boot: "Boot",
  sandal: "Sandal",
  slide: "Slide",
  flipflop: "Flip-flop",
};

export const GENDER_LABEL: Record<Gender, string> = {
  men: "Men",
  women: "Women",
  unisex: "Unisex",
  kids: "Kids",
};

/** One row of /admin/products. */
export type ProductListRow = {
  id: string;
  name: string;
  slug: string;
  brandName: string | null;
  categoryName: string | null;
  basePrice: number;
  salePrice: number | null;
  isActive: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  variantCount: number;
  totalStock: number;
  imageUrl: string | null;
  imageAlt: string | null;
  /**
   * Whether this product has ever been on an order. Decides what the delete
   * dialog promises — hidden, or gone — so the sentence matches what
   * `admin_delete_product` will actually do rather than guessing.
   */
  hasOrders: boolean;
};

export type AdminVariant = {
  id: string;
  size: string;
  color: string;
  colorHex: string | null;
  sku: string;
  /** Paise. Null means the product price applies. */
  priceOverride: number | null;
  stock: number;
  isActive: boolean;
  /** Order lines pointing at this size. Non-zero means never hard-delete it. */
  orderCount: number;
};

export type AdminImage = {
  id: string;
  url: string;
  altText: string | null;
  sortOrder: number;
  isPrimary: boolean;
  color: string | null;
  /**
   * The untouched upload this was derived from, or null for a seed placeholder
   * and for anything uploaded before Phase 10 kept originals.
   *
   * Present here because it is what decides whether a photograph can be
   * re-framed at all: null means the only copy the shop has is already cropped,
   * and the honest answer in the UI is "re-upload it", not a disabled button
   * with no explanation.
   */
  originalPath: string | null;
  /** How it was framed. Null means the whole photograph, as before crops. */
  crop: unknown;
};

export type AdminProductDetail = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  brandId: string | null;
  categoryId: string | null;
  gender: Gender;
  footwearType: FootwearType;
  material: string | null;
  /** Paise, both of them. */
  basePrice: number;
  salePrice: number | null;
  isActive: boolean;
  isFeatured: boolean;
  metaTitle: string | null;
  metaDescription: string | null;
  weightGrams: number | null;
  lengthCm: number | null;
  breadthCm: number | null;
  heightCm: number | null;
  searchKeywords: string[];
  deletedAt: string | null;
  variants: AdminVariant[];
  images: AdminImage[];
};

export type CatalogOption = { id: string; name: string; isActive: boolean };

/** The shop-wide parcel the Shiprocket payload falls back to. */
export type ParcelDefaults = {
  weightGrams: number;
  lengthCm: number;
  breadthCm: number;
  heightCm: number;
};

/** A slug the database will accept, derived from whatever the owner typed. */
export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      // NFKD splits "é" into "e" plus a combining accent; the second replace then
      // drops the accent rather than turning it into a hyphen.
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 140)
  );
}
