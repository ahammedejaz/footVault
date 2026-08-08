import "server-only";

import type { ListParams } from "@/lib/admin/list-params";
import { rows } from "@/lib/queries/run";
import { createClient } from "@/lib/supabase/server";

/**
 * The product photograph library.
 *
 * The bucket name is not a guess: `supabase/migrations/…_storage.sql` creates
 * three public-read buckets — `product-images`, `category-images` and
 * `site-assets` — and migration 0011 narrows the two photographic ones to
 * jpeg/png/webp/avif because an uploaded SVG can carry script and next.config
 * has `dangerouslyAllowSVG` on for the drawn seed assets. This screen browses
 * the product one, which is where the images a product page renders live.
 *
 * **Why the listing is read whole and paged here.** The Storage API's `list()`
 * takes a limit and an offset but returns no total, so a `Pagination` built on
 * it could only ever draw arrows and never say "26–50 of 137" — and the range
 * is the thing the owner actually reads. It also filters by a prefix rather
 * than a substring, and cannot sort by size at all. One capped read gives an
 * honest total, a real search and a real sort; `capped` reports the ceiling
 * rather than silently showing a subset of a library.
 */

export const PRODUCT_IMAGE_BUCKET = "product-images";

/** Bytes. Matches the bucket's own `file_size_limit`, set in the migration. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** What the bucket's `allowed_mime_types` will accept. Rejected earlier here. */
export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
] as const;

/** One folder's ceiling. Reaching it is reported rather than truncated quietly. */
const MAX_OBJECTS = 1000;

/** Image rows read to work out what is in use. A catalog's worth, and no more. */
const MAX_IMAGE_ROWS = 3000;

export const MEDIA_SORTS = ["name", "created_at", "size"] as const;
export type MediaSort = (typeof MEDIA_SORTS)[number];

export type MediaUsage = {
  /** The `product_images` row, so a delete can take it with the file. */
  imageRowId: string;
  productId: string;
  productName: string;
  isPrimary: boolean;
};

export type MediaItem = {
  /** Path inside the bucket. The identity everything else is keyed on. */
  path: string;
  /** The last segment, which is what the owner recognises. */
  fileName: string;
  publicUrl: string;
  sizeBytes: number | null;
  mimeType: string | null;
  createdAt: string | null;
  /** Products whose image rows point at this file. Empty means safe to delete. */
  usedBy: MediaUsage[];
};

export type MediaFolder = { prefix: string; name: string };

export type MediaListing = {
  items: MediaItem[];
  folders: MediaFolder[];
  total: number;
  capped: boolean;
  /** Files in this folder that no product is using. */
  unusedCount: number;
};

/** One level of the bucket. `prefix` is "" for the root. */
export async function listMedia(
  params: ListParams<MediaSort>,
  prefix: string,
): Promise<MediaListing> {
  const supabase = await createClient();

  const { data, error } = await supabase.storage
    .from(PRODUCT_IMAGE_BUCKET)
    .list(prefix, {
      limit: MAX_OBJECTS + 1,
      sortBy: { column: "name", order: "asc" },
    });

  if (error) {
    // Same rule as a dropped PostgREST error: an empty grid would read as an
    // empty bucket, and the owner would upload a photograph they already have.
    throw new Error(`admin.media.list: ${error.message}`);
  }

  const entries = data ?? [];
  const capped = entries.length > MAX_OBJECTS;
  const visible = capped ? entries.slice(0, MAX_OBJECTS) : entries;

  // A folder comes back with a null id and no metadata. Supabase also keeps an
  // empty folder alive with a zero-byte `.emptyFolderPlaceholder`; it is an
  // artefact of the storage layer, not a photograph, and showing it invites
  // somebody to delete it and lose the folder.
  const folders: MediaFolder[] = [];
  const files: typeof visible = [];
  for (const entry of visible) {
    if (entry.id === null) {
      folders.push({
        name: entry.name,
        prefix: prefix ? `${prefix}/${entry.name}` : entry.name,
      });
    } else if (entry.name !== ".emptyFolderPlaceholder") {
      files.push(entry);
    }
  }

  const term = params.q.trim().toLowerCase();
  const filtered = term
    ? files.filter((file) => file.name.toLowerCase().includes(term))
    : files;

  const direction = params.dir === "asc" ? 1 : -1;
  const sorted = [...filtered].sort((a, b) => {
    if (params.sort === "size") {
      return ((a.metadata?.size ?? 0) - (b.metadata?.size ?? 0)) * direction;
    }
    if (params.sort === "created_at") {
      return (a.created_at ?? "").localeCompare(b.created_at ?? "") * direction;
    }
    return a.name.localeCompare(b.name) * direction;
  });

  const usage = await loadUsage();
  const pathOf = (name: string) => (prefix ? `${prefix}/${name}` : name);

  const from = (params.page - 1) * params.perPage;
  const items: MediaItem[] = sorted
    .slice(from, from + params.perPage)
    .map((file) => {
      const path = pathOf(file.name);
      return {
        path,
        fileName: file.name,
        publicUrl: publicUrlFor(supabase, path),
        sizeBytes: file.metadata?.size ?? null,
        mimeType: file.metadata?.mimetype ?? null,
        createdAt: file.created_at,
        usedBy: usage.get(path) ?? [],
      };
    });

  return {
    items,
    folders,
    total: sorted.length,
    capped,
    // Counted over the whole filtered set rather than the page: "4 of these are
    // unused" is a fact about the library; the same figure for page three is
    // noise the owner cannot act on.
    unusedCount: sorted.filter((file) => !usage.has(pathOf(file.name))).length,
  };
}

/** One file's usage, for an action that is about to delete it. */
export async function mediaUsage(path: string): Promise<MediaUsage[]> {
  const usage = await loadUsage();
  return usage.get(path) ?? [];
}

type ServerClient = Awaited<ReturnType<typeof createClient>>;

function publicUrlFor(supabase: ServerClient, path: string): string {
  return supabase.storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(path).data
    .publicUrl;
}

/**
 * Every product image that points into this bucket, keyed by its path.
 *
 * One `ilike` over `product_images` rather than a lookup per file. The obvious
 * alternative — building the expected public URL for each of the page's files
 * and matching them with `in` — puts a few hundred long URLs into a GET query
 * string, and it only matches a URL stored in exactly the shape this file would
 * have produced. Reading the rows and parsing the path out of each one instead
 * is one small request, and it recognises a URL however it was written: with a
 * `?download=` on the end, with a transform, or as a bare bucket-relative path.
 *
 * `product_images.url` is free text, which is why this is parsing rather than a
 * join. The cap is the catalog's plausible size; past it a file could show as
 * unused when it is not, so the confirmation dialog states what it found rather
 * than asserting that nothing uses the file.
 */
async function loadUsage(): Promise<Map<string, MediaUsage[]>> {
  const supabase = await createClient();
  const result = new Map<string, MediaUsage[]>();

  const imageRows = await rows<{
    id: string;
    product_id: string;
    url: string;
    is_primary: boolean;
  }>(
    "admin.media.usage",
    supabase
      .from("product_images")
      .select("id, product_id, url, is_primary")
      .ilike("url", `%${PRODUCT_IMAGE_BUCKET}/%`)
      .limit(MAX_IMAGE_ROWS),
  );
  if (imageRows.length === 0) return result;

  const productIds = [...new Set(imageRows.map((row) => row.product_id))];
  const products = await rows<{ id: string; name: string }>(
    "admin.media.usageProducts",
    supabase.from("products").select("id, name").in("id", productIds),
  );
  const nameById = new Map(products.map((row) => [row.id, row.name]));

  for (const row of imageRows) {
    const path = pathInBucket(row.url);
    if (!path) continue;
    const list = result.get(path) ?? [];
    list.push({
      imageRowId: row.id,
      productId: row.product_id,
      // A product this admin cannot read is not one to name, and the count
      // still tells them the file is spoken for.
      productName: nameById.get(row.product_id) ?? "a product",
      isPrimary: row.is_primary,
    });
    result.set(path, list);
  }
  return result;
}

/**
 * `…/product-images/shoes/hero.jpg?download=` → `shoes/hero.jpg`.
 *
 * Returns null for anything that does not name this bucket, so a seed asset
 * served from /public is not mistaken for a file that could be deleted here.
 */
function pathInBucket(url: string): string | null {
  const marker = `${PRODUCT_IMAGE_BUCKET}/`;
  const at = url.indexOf(marker);
  if (at === -1) return null;
  const tail = url.slice(at + marker.length).split("?")[0] ?? "";
  if (!tail) return null;
  try {
    return decodeURIComponent(tail);
  } catch {
    // A malformed escape is not a reason to fail the whole screen.
    return tail;
  }
}

/** "1.4 MB". Bytes are not a number a shop owner reads. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
