/**
 * Seeds the Foot Vault catalog.
 *
 *   npm run seed        upsert straight into Supabase (needs SUPABASE_SERVICE_ROLE_KEY)
 *   npm run seed:sql    write supabase/seed.sql instead, for `supabase db reset`
 *
 * Both modes read the same tables in scripts/seed-data.ts, so the SQL file and
 * the live database can never drift. Every write is an upsert keyed on a
 * natural key (slug, sku, page slug, setting key), which makes reseeding
 * idempotent: run it twice and you get one catalog, not two.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  brands,
  categories,
  collections,
  heroBanner,
  homepageSections,
  pages,
  products,
  SEARCH_KEYWORDS,
  siteSettings,
  SIZE_RUN_KIDS,
  SIZE_RUN_MEN,
  SIZE_RUN_WOMEN,
  type SeedProduct,
} from "./seed-data";
import { colorSlug } from "./color-slug";

// -----------------------------------------------------------------------------
// Derived rows
// -----------------------------------------------------------------------------

function sizeRunFor(product: SeedProduct): string[] {
  // A clearance line down to one size overrides its gender's run.
  if (product.sizeRun) return product.sizeRun;
  if (product.gender === "kids") return SIZE_RUN_KIDS;
  if (product.gender === "women") return SIZE_RUN_WOMEN;
  return SIZE_RUN_MEN;
}

/**
 * Default stock for a size with nothing special about it.
 *
 * A flat number rather than a hash of the SKU: the SQL and the supabase-js
 * paths have to agree on every value they write, and a JavaScript string hash
 * is not something Postgres can reproduce. Nothing in the UI is poorer for it —
 * the only stock figure a customer ever sees is the "only 2 left" line, and
 * that comes from the lowStock overrides in seed-data.ts.
 */
const DEFAULT_STOCK = 8;

const code = (value: string, length: number) =>
  value
    .replace(/[^a-z0-9]+/gi, "")
    .toUpperCase()
    .slice(0, length);

/**
 * FV-BRAND-MODEL-COLOUR-SIZE.
 *
 * The model segment is the slug with its brand prefix stripped, not the first
 * six characters of the whole slug: `adidas-samba-og-mens` and
 * `adidas-adizero-sl-mens` both start "adidas", so truncating the raw slug gave
 * both of them the same SKU in their shared Core Black colourway. The unique
 * index on product_variants.sku caught it, which is the point of having it —
 * assertUniqueSkus() below now catches it before the database has to.
 */
export function skuFor(
  product: SeedProduct,
  colorName: string,
  size: string,
): string {
  const model = product.slug.startsWith(`${product.brand}-`)
    ? product.slug.slice(product.brand.length + 1)
    : product.slug;
  return `FV-${code(product.brand, 6)}-${code(model, 8)}-${code(colorName, 6)}-${size}`;
}

/**
 * Sizes whose stock is not the default: sold out is 0, low stock is whatever
 * seed-data.ts says. Applied across every colourway of the product, so the
 * size run on a card strikes a size through rather than showing it available
 * in a colour the customer has not picked yet.
 */
export function stockOverrides(product: SeedProduct): Record<string, number> {
  const out: Record<string, number> = {};
  for (const size of product.soldOut ?? []) out[size] = 0;
  for (const [size, qty] of Object.entries(product.lowStock ?? {}))
    out[size] = qty;
  return out;
}

export type VariantRow = {
  productSlug: string;
  size: string;
  color: string;
  colorHex: string;
  sku: string;
  stock: number;
};

export function variantsFor(product: SeedProduct): VariantRow[] {
  const rows: VariantRow[] = [];
  for (const color of product.colors) {
    for (const size of sizeRunFor(product)) {
      const sku = skuFor(product, color.name, size);
      // A size that is out is out in every colourway, so the size run on the
      // card strikes it through rather than showing it available in a colour
      // the customer has not picked yet.
      rows.push({
        productSlug: product.slug,
        size,
        color: color.name,
        colorHex: color.hex,
        sku,
        stock: stockOverrides(product)[size] ?? DEFAULT_STOCK,
      });
    }
  }
  return rows;
}

/**
 * One hero and one outsole per colourway.
 *
 * The outsole is the tread shot every footwear shoot produces and nobody puts
 * on the card; the card reveals it on hover, and the product page opens on it
 * as the second frame. Per colourway rather than per product because the
 * swatches switch the gallery, which they cannot do if there is only one.
 *
 * Exactly one primary per product — the first colourway's hero — because
 * product_images carries a partial unique index that says so.
 */
export function imagesFor(product: SeedProduct) {
  return product.colors.flatMap((color, position) => {
    const stem = `/seed/${product.slug}-${colorSlug(color.name)}`;
    return [
      {
        url: `${stem}-hero.svg`,
        alt: `${product.name} in ${color.name}, side profile`,
        color: color.name,
        sortOrder: position * 2,
        isPrimary: position === 0,
      },
      {
        url: `${stem}-sole.svg`,
        alt: `${product.name} in ${color.name} outsole`,
        color: color.name,
        sortOrder: position * 2 + 1,
        isPrimary: false,
      },
    ];
  });
}

// -----------------------------------------------------------------------------
// SQL mode
// -----------------------------------------------------------------------------

/** Single-quote a SQL literal. null and undefined become NULL. */
function q(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return `'${value.replace(/'/g, "''")}'`;
}

const j = (value: unknown) => `${q(JSON.stringify(value))}::jsonb`;

function buildSql(): string {
  const out: string[] = [];
  const push = (...lines: string[]) => out.push(...lines, "");

  push(
    "-- Generated by scripts/seed.ts — do not edit by hand.",
    "-- Regenerate with: npm run seed:sql",
    "--",
    "-- Every statement is an upsert on a natural key, so this file is safe to",
    "-- run repeatedly against the same database.",
  );

  push(
    "-- --- brands ---------------------------------------------------------------",
    "insert into public.brands (name, slug) values",
    brands.map((b) => `  (${q(b.name)}, ${q(b.slug)})`).join(",\n") +
      "\non conflict (slug) do update set name = excluded.name;",
  );

  const parents = categories.filter((c) => !c.parent);
  const children = categories.filter((c) => c.parent);

  push(
    "-- --- categories -----------------------------------------------------------",
    "-- Parents first: a child's parent_id is resolved by slug, so the row it",
    "-- points at has to exist by the time the child is inserted.",
    "insert into public.categories (name, slug, description, sort_order, image_url) values",
    parents
      .map(
        (c) =>
          `  (${q(c.name)}, ${q(c.slug)}, ${q(c.description ?? null)}, ${c.sortOrder}, ${q(c.imageUrl ?? null)})`,
      )
      .join(",\n") +
      "\non conflict (slug) do update set name = excluded.name, description = excluded.description, sort_order = excluded.sort_order, image_url = excluded.image_url;",
  );

  push(
    "insert into public.categories (name, slug, description, sort_order, parent_id) values",
    children
      .map(
        (c) =>
          `  (${q(c.name)}, ${q(c.slug)}, ${q(c.description ?? null)}, ${c.sortOrder}, (select id from public.categories where slug = ${q(c.parent!)}))`,
      )
      .join(",\n") +
      "\non conflict (slug) do update set name = excluded.name, sort_order = excluded.sort_order, parent_id = excluded.parent_id;",
  );

  push(
    "-- --- products -------------------------------------------------------------",
    "insert into public.products (name, slug, description, category_id, brand_id, gender, footwear_type, material, base_price, sale_price, is_featured, meta_title, meta_description, search_keywords) values",
    products
      .map((p) => {
        const metaTitle =
          `${p.name} — ${brands.find((b) => b.slug === p.brand)?.name ?? ""}`.trim();
        // First sentence. Descriptions that are a single sentence already carry
        // their full stop, so strip before re-adding rather than emit "tap..".
        const metaDescription =
          p.description.split(". ")[0]!.replace(/\.$/, "") + ".";
        const keywords = SEARCH_KEYWORDS[p.footwearType] ?? [];
        return `  (${q(p.name)}, ${q(p.slug)}, ${q(p.description)}, (select id from public.categories where slug = ${q(p.category)}), (select id from public.brands where slug = ${q(p.brand)}), ${q(p.gender)}, ${q(p.footwearType)}, ${q(p.material)}, ${p.basePrice}, ${p.salePrice ?? "NULL"}, ${p.featured ? "true" : "false"}, ${q(metaTitle)}, ${q(metaDescription)}, array[${keywords.map(q).join(", ")}]::text[])`;
      })
      .join(",\n") +
      "\non conflict (slug) do update set name = excluded.name, description = excluded.description, category_id = excluded.category_id, brand_id = excluded.brand_id, gender = excluded.gender, footwear_type = excluded.footwear_type, material = excluded.material, base_price = excluded.base_price, sale_price = excluded.sale_price, is_featured = excluded.is_featured, meta_title = excluded.meta_title, meta_description = excluded.meta_description, search_keywords = excluded.search_keywords;",
  );

  push(
    "-- --- images ---------------------------------------------------------------",
    "-- One hero and one outsole per *colourway*, not per product: the swatches on",
    "-- the product page change the gallery, which they can only do if the gallery",
    "-- has something to change to.",
    "--",
    "-- Set-based rather than one row per image: the URL and the alt text are both",
    "-- derived from the product and the colour, so listing them as literals would",
    "-- only be more places for them to drift out of step with",
    "-- scripts/generate-seed-images.ts. The colour slug below is the SQL twin of",
    "-- colorSlug() in that file — a mismatch is a broken image, so they change",
    "-- together.",
    "--",
    "-- Cleared first because product_images has no natural key to upsert on, and",
    "-- the partial unique index on (product_id) where is_primary would reject a",
    "-- second primary before the first was gone.",
    "delete from public.product_images;",
    "with colorway (product_slug, color, position) as (values",
    products
      .flatMap((p) =>
        p.colors.map((c, i) => `  (${q(p.slug)}, ${q(c.name)}, ${i})`),
      )
      .join(",\n"),
    "),",
    "view (kind, offset_in_pair, suffix) as (values",
    "  ('hero', 0, ', side profile'),",
    "  ('sole', 1, ' outsole')",
    ")",
    "insert into public.product_images (product_id, url, alt_text, sort_order, is_primary, color)",
    "select p.id,",
    "       '/seed/' || p.slug || '-'",
    "         || trim(both '-' from lower(regexp_replace(c.color, '[^a-zA-Z0-9]+', '-', 'g')))",
    "         || '-' || v.kind || '.svg',",
    "       p.name || ' in ' || c.color || v.suffix,",
    "       c.position * 2 + v.offset_in_pair,",
    "       -- Exactly one primary per product: the first colourway's hero. It is",
    "       -- what the card shows and what the gallery opens on.",
    "       c.position = 0 and v.kind = 'hero',",
    "       c.color",
    "  from public.products p",
    "  join colorway c on c.product_slug = p.slug",
    "  cross join view v;",
  );

  push(
    "-- --- variants -------------------------------------------------------------",
    "-- One row per size per colourway, generated by joining each product to the",
    "-- size run for its gender. 384 variants, without 384 lines of literals for a",
    "-- reviewer to check the SKU format on.",
    "--",
    `-- Stock is ${DEFAULT_STOCK} unless the override table below says otherwise: 0 for a size`,
    "-- that is genuinely out, or the real remaining count for a size down to its",
    "-- last pairs.",
    "with run (gender, sizes) as (values",
    [
      `  ('men'::public.gender_group,    array[${SIZE_RUN_MEN.map(q).join(", ")}])`,
      `  ('unisex'::public.gender_group, array[${SIZE_RUN_MEN.map(q).join(", ")}])`,
      `  ('women'::public.gender_group,  array[${SIZE_RUN_WOMEN.map(q).join(", ")}])`,
      `  ('kids'::public.gender_group,   array[${SIZE_RUN_KIDS.map(q).join(", ")}])`,
    ].join(",\n"),
    "),",
    "colorway (product_slug, color, hex) as (values",
    products
      .flatMap((p) =>
        p.colors.map((c) => `  (${q(p.slug)}, ${q(c.name)}, ${q(c.hex)})`),
      )
      .join(",\n"),
    "),",
    "override (product_slug, size, qty) as (values",
    products
      .flatMap((p) =>
        Object.entries(stockOverrides(p)).map(
          ([size, qty]) => `  (${q(p.slug)}, ${q(size)}, ${qty})`,
        ),
      )
      .join(",\n"),
    ")",
    "insert into public.product_variants (product_id, size, color, color_hex, sku, stock_quantity)",
    "select p.id, s.size, c.color, c.hex,",
    "       -- FV-BRAND-MODEL-COLOUR-SIZE, matching skuFor() in seed.ts. The model",
    "       -- segment strips the brand prefix off the slug, because two adidas",
    "       -- products share their first six characters and would otherwise share",
    "       -- a SKU in a shared colourway.",
    "       'FV-' || upper(left(regexp_replace(b.slug, '[^a-zA-Z0-9]', '', 'g'), 6))",
    "           || '-' || upper(left(regexp_replace(",
    "                case when p.slug like b.slug || '-%'",
    "                     then substr(p.slug, length(b.slug) + 2)",
    "                     else p.slug end,",
    "                '[^a-zA-Z0-9]', '', 'g'), 8))",
    "           || '-' || upper(left(regexp_replace(c.color, '[^a-zA-Z0-9]', '', 'g'), 6))",
    "           || '-' || s.size,",
    `       coalesce(o.qty, ${DEFAULT_STOCK})`,
    "  from public.products p",
    "  join public.brands b on b.id = p.brand_id",
    "  join colorway c on c.product_slug = p.slug",
    "  join run r on r.gender = p.gender",
    "  cross join lateral unnest(r.sizes) as s(size)",
    "  left join override o on o.product_slug = p.slug and o.size = s.size",
    "on conflict (product_id, size, color) do update",
    "  set sku = excluded.sku, color_hex = excluded.color_hex, stock_quantity = excluded.stock_quantity;",
  );

  push(
    "-- --- collections ----------------------------------------------------------",
    "insert into public.collections (name, slug, description, sort_order) values",
    collections
      .map(
        (c) =>
          `  (${q(c.name)}, ${q(c.slug)}, ${q(c.description)}, ${c.sortOrder})`,
      )
      .join(",\n") +
      "\non conflict (slug) do update set name = excluded.name, description = excluded.description, sort_order = excluded.sort_order;",
    "insert into public.collection_products (collection_id, product_id, sort_order) values",
    collections
      .flatMap((c) =>
        c.products.map(
          (slug, i) =>
            `  ((select id from public.collections where slug = ${q(c.slug)}), (select id from public.products where slug = ${q(slug)}), ${i})`,
        ),
      )
      .join(",\n") +
      "\non conflict (collection_id, product_id) do update set sort_order = excluded.sort_order;",
  );

  push(
    "-- --- the homepage hero ----------------------------------------------------",
    "-- Two crops of one scene. A 16:9 hero cropped to a 390px phone loses the",
    "-- shoe; a phone-shaped hero stretched across a desktop loses the point.",
    "-- placement is the natural key: one hero per placement, replaced on reseed.",
    "delete from public.banners where placement = " +
      q(heroBanner.placement) +
      ";",
    "insert into public.banners (placement, image_url, mobile_image_url, headline, subtext, cta_label, cta_href, sort_order)",
    `values (${q(heroBanner.placement)}, ${q(heroBanner.imageUrl)}, ${q(heroBanner.mobileImageUrl)}, ${q(heroBanner.headline)}, ${q(heroBanner.subtext)}, ${q(heroBanner.ctaLabel)}, ${q(heroBanner.ctaHref)}, 0);`,
  );

  push(
    "-- --- CMS pages ------------------------------------------------------------",
    "insert into public.pages (slug, title, body, meta_title, meta_description, is_published) values",
    pages
      .map(
        (p) =>
          `  (${q(p.slug)}, ${q(p.title)}, ${q(p.body)}, ${p.metaTitle === undefined ? "null" : q(p.metaTitle)}, ${q(p.metaDescription)}, true)`,
      )
      .join(",\n") +
      "\non conflict (slug) do update set title = excluded.title, body = excluded.body, meta_title = excluded.meta_title, meta_description = excluded.meta_description, is_published = excluded.is_published;",
  );

  push(
    "-- --- settings -------------------------------------------------------------",
    "insert into public.site_settings (key, value, description) values",
    siteSettings
      .map((s) => `  (${q(s.key)}, ${j(s.value)}, ${q(s.description)})`)
      .join(",\n") +
      "\non conflict (key) do update set value = excluded.value, description = excluded.description;",
  );

  push(
    "-- --- homepage -------------------------------------------------------------",
    "-- Replaced wholesale: sort_order is the identity of a section here, and a",
    "-- reseed should restore the designed homepage rather than merge with",
    "-- whatever the owner last dragged around.",
    "delete from public.homepage_sections;",
    "insert into public.homepage_sections (section_type, title, subtitle, payload, sort_order) values",
    homepageSections
      .map(
        (s) =>
          `  (${q(s.sectionType)}, ${q(s.title)}, ${q("subtitle" in s ? (s.subtitle as string) : null)}, ${j(s.payload)}, ${s.sortOrder})`,
      )
      .join(",\n") + ";",
  );

  return out.join("\n");
}

// -----------------------------------------------------------------------------
// Live mode
// -----------------------------------------------------------------------------

async function seedViaSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n" +
        "Copy .env.example to .env.local and fill them in, or run `npm run seed:sql`\n" +
        "to write supabase/seed.sql and apply that instead.",
    );
    process.exitCode = 1;
    return;
  }

  const { createClient } = await import("@supabase/supabase-js");
  // The service role bypasses RLS. This script is the only place outside
  // src/lib/supabase/admin.ts that is allowed to hold this key, and it never
  // runs in the browser.
  const db = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const fail = (step: string, error: { message: string } | null) => {
    if (!error) return;
    throw new Error(`${step}: ${error.message}`);
  };

  fail(
    "brands",
    (
      await db.from("brands").upsert(
        brands.map((b) => ({ name: b.name, slug: b.slug })),
        { onConflict: "slug" },
      )
    ).error,
  );

  const parents = categories.filter((c) => !c.parent);
  fail(
    "categories (top level)",
    (
      await db.from("categories").upsert(
        parents.map((c) => ({
          name: c.name,
          slug: c.slug,
          description: c.description ?? null,
          sort_order: c.sortOrder,
          image_url: c.imageUrl ?? null,
        })),
        { onConflict: "slug" },
      )
    ).error,
  );

  const { data: parentRows, error: parentError } = await db
    .from("categories")
    .select("id, slug");
  fail("categories (read back)", parentError);
  const categoryId = new Map((parentRows ?? []).map((r) => [r.slug, r.id]));

  fail(
    "categories (children)",
    (
      await db.from("categories").upsert(
        categories
          .filter((c) => c.parent)
          .map((c) => ({
            name: c.name,
            slug: c.slug,
            sort_order: c.sortOrder,
            parent_id: categoryId.get(c.parent!) ?? null,
          })),
        { onConflict: "slug" },
      )
    ).error,
  );

  const { data: allCategories, error: categoryReadError } = await db
    .from("categories")
    .select("id, slug");
  fail("categories (read back)", categoryReadError);
  const { data: allBrands, error: brandReadError } = await db
    .from("brands")
    .select("id, slug");
  fail("brands (read back)", brandReadError);
  const catId = new Map((allCategories ?? []).map((r) => [r.slug, r.id]));
  const brandId = new Map((allBrands ?? []).map((r) => [r.slug, r.id]));

  fail(
    "products",
    (
      await db.from("products").upsert(
        products.map((p) => ({
          name: p.name,
          slug: p.slug,
          description: p.description,
          category_id: catId.get(p.category) ?? null,
          brand_id: brandId.get(p.brand) ?? null,
          gender: p.gender,
          footwear_type: p.footwearType,
          material: p.material,
          base_price: p.basePrice,
          sale_price: p.salePrice ?? null,
          is_featured: p.featured ?? false,
          meta_title:
            `${p.name} — ${brands.find((b) => b.slug === p.brand)?.name ?? ""}`.trim(),
          meta_description:
            p.description.split(". ")[0]!.replace(/\.$/, "") + ".",
          search_keywords: SEARCH_KEYWORDS[p.footwearType] ?? [],
        })),
        { onConflict: "slug" },
      )
    ).error,
  );

  const { data: productRows, error: productReadError } = await db
    .from("products")
    .select("id, slug");
  fail("products (read back)", productReadError);
  const productId = new Map((productRows ?? []).map((r) => [r.slug, r.id]));
  const ids = products.map((p) => productId.get(p.slug)!).filter(Boolean);

  // Cleared first: the partial unique index on (product_id) where is_primary
  // rejects a second primary before the old one is gone.
  fail(
    "product_images (clear)",
    (await db.from("product_images").delete().in("product_id", ids)).error,
  );
  fail(
    "product_images",
    (
      await db.from("product_images").insert(
        products.flatMap((p) =>
          imagesFor(p).map((img) => ({
            product_id: productId.get(p.slug)!,
            url: img.url,
            alt_text: img.alt,
            sort_order: img.sortOrder,
            is_primary: img.isPrimary,
            color: img.color,
          })),
        ),
      )
    ).error,
  );

  fail(
    "product_variants",
    (
      await db.from("product_variants").upsert(
        products.flatMap((p) =>
          variantsFor(p).map((v) => ({
            product_id: productId.get(p.slug)!,
            size: v.size,
            color: v.color,
            color_hex: v.colorHex,
            sku: v.sku,
            stock_quantity: v.stock,
          })),
        ),
        { onConflict: "product_id,size,color" },
      )
    ).error,
  );

  fail(
    "collections",
    (
      await db.from("collections").upsert(
        collections.map((c) => ({
          name: c.name,
          slug: c.slug,
          description: c.description,
          sort_order: c.sortOrder,
        })),
        { onConflict: "slug" },
      )
    ).error,
  );
  fail(
    "banners (clear)",
    (await db.from("banners").delete().eq("placement", heroBanner.placement))
      .error,
  );
  fail(
    "banners",
    (
      await db.from("banners").insert({
        placement: heroBanner.placement,
        image_url: heroBanner.imageUrl,
        mobile_image_url: heroBanner.mobileImageUrl,
        headline: heroBanner.headline,
        subtext: heroBanner.subtext,
        cta_label: heroBanner.ctaLabel,
        cta_href: heroBanner.ctaHref,
        sort_order: 0,
      })
    ).error,
  );

  const { data: collectionRows, error: collectionReadError } = await db
    .from("collections")
    .select("id, slug");
  fail("collections (read back)", collectionReadError);
  const collectionId = new Map(
    (collectionRows ?? []).map((r) => [r.slug, r.id]),
  );
  fail(
    "collection_products",
    (
      await db.from("collection_products").upsert(
        collections.flatMap((c) =>
          c.products.map((slug, i) => ({
            collection_id: collectionId.get(c.slug)!,
            product_id: productId.get(slug)!,
            sort_order: i,
          })),
        ),
        { onConflict: "collection_id,product_id" },
      )
    ).error,
  );

  fail(
    "pages",
    (
      await db.from("pages").upsert(
        pages.map((p) => ({
          slug: p.slug,
          title: p.title,
          body: p.body,
          /*
            `meta_title` is optional and mostly absent, on purpose: the root
            template already appends the brand, so a page that sets it to
            "About Foot Vault" renders "About Foot Vault — Foot Vault". It is
            set only where the page title is the wrong length or shape for a
            search result. `?? null` rather than omitted, so re-seeding a page
            that had one clears it — an upsert that leaves a stale value behind
            is the drift this whole batch is about.
          */
          meta_title: p.metaTitle ?? null,
          meta_description: p.metaDescription,
          is_published: true,
        })),
        { onConflict: "slug" },
      )
    ).error,
  );

  fail(
    "site_settings",
    (
      await db.from("site_settings").upsert(
        siteSettings.map((s) => ({
          key: s.key,
          value: s.value,
          description: s.description,
        })),
        { onConflict: "key" },
      )
    ).error,
  );

  fail(
    "homepage_sections (clear)",
    (await db.from("homepage_sections").delete().gte("sort_order", 0)).error,
  );
  fail(
    "homepage_sections",
    (
      await db.from("homepage_sections").insert(
        homepageSections.map((s) => ({
          section_type: s.sectionType,
          title: s.title,
          subtitle: "subtitle" in s ? (s.subtitle as string) : null,
          payload: s.payload,
          sort_order: s.sortOrder,
        })),
      )
    ).error,
  );

  const variantCount = products.reduce((n, p) => n + variantsFor(p).length, 0);
  console.log(
    `Seeded ${products.length} products, ${variantCount} variants, ${categories.length} categories, ` +
      `${brands.length} brands, ${collections.length} collections, ${pages.length} pages.`,
  );
}

/**
 * A duplicate SKU is a data bug that the unique index would only surface
 * halfway through an insert, leaving a half-seeded catalog behind. Check it up
 * front, where the message can name both offenders.
 */
function assertUniqueSkus() {
  const seen = new Map<string, string>();
  for (const product of products) {
    for (const variant of variantsFor(product)) {
      const previous = seen.get(variant.sku);
      if (previous) {
        throw new Error(
          `Duplicate SKU ${variant.sku}: ${previous} and ${product.slug} generate the same one.`,
        );
      }
      seen.set(variant.sku, product.slug);
    }
  }
}

async function main() {
  assertUniqueSkus();
  if (process.argv.includes("--sql")) {
    const target = join(process.cwd(), "supabase", "seed.sql");
    writeFileSync(target, buildSql() + "\n");
    const variantCount = products.reduce(
      (n, p) => n + variantsFor(p).length,
      0,
    );
    const imageCount = products.reduce((n, p) => n + imagesFor(p).length, 0);
    console.log(
      `Wrote supabase/seed.sql — ${products.length} products, ${variantCount} variants, ` +
        `${imageCount} images.`,
    );
    return;
  }
  await seedViaSupabase();
}

// Only when run as a script. variantsFor(), imagesFor() and skuFor() are
// importable helpers, and importing this file should not start seeding.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
