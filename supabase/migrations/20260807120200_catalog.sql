-- =============================================================================
-- 0003 · Catalog
--
-- categories -> products -> product_variants is the spine. A variant is the
-- unit that actually has stock and a SKU; a product is the thing with a page.
-- collections are curated rails the owner controls from /admin/appearance.
-- =============================================================================

create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  parent_id   uuid references public.categories (id) on delete set null,
  description text,
  image_url   text,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Self-reference is for one level of nesting (Men -> Sneakers). A category
  -- that is its own parent would make the tree walk in /admin/categories loop.
  constraint categories_parent_not_self check (parent_id is distinct from id)
);

create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

create index categories_parent_id_idx on public.categories (parent_id);
create index categories_active_sort_idx on public.categories (sort_order) where is_active;

create table public.brands (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  logo_url   text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger brands_set_updated_at
  before update on public.brands
  for each row execute function public.set_updated_at();

-- --- products ----------------------------------------------------------------

create table public.products (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  slug             text not null unique,
  description      text,
  category_id      uuid references public.categories (id) on delete set null,
  brand_id         uuid references public.brands (id) on delete set null,
  gender           public.gender_group not null default 'unisex',
  footwear_type    public.footwear_type not null,
  material         text,
  -- Integer paise. ₹8,995 is stored as 899500.
  base_price       bigint not null check (base_price > 0),
  sale_price       bigint check (sale_price > 0),
  is_active        boolean not null default true,
  is_featured      boolean not null default false,
  meta_title       text,
  meta_description text,
  -- Soft delete. A product that appears in a past order is never removed, so
  -- order history cannot break; the storefront filters on deleted_at is null.
  deleted_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- A "sale" that is not cheaper is a lie to the customer and a broken
  -- strikethrough in the UI. Rejected at the source.
  constraint products_sale_below_base check (sale_price is null or sale_price < base_price)
);

create trigger products_set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

create index products_category_id_idx on public.products (category_id);
create index products_brand_id_idx    on public.products (brand_id);
-- The storefront's universal predicate: live products, newest first.
create index products_live_created_idx on public.products (created_at desc)
  where is_active and deleted_at is null;
-- The homepage's featured rail, which is the first query on the busiest page.
create index products_featured_idx on public.products (created_at desc)
  where is_featured and is_active and deleted_at is null;

create index products_gender_type_idx on public.products (gender, footwear_type)
  where is_active and deleted_at is null;

-- Trigram index for /search. Supports `name ilike '%runner%'`, which a btree
-- cannot: a leading wildcard makes an ordinary index unusable.
create index products_name_trgm_idx on public.products
  using gin (name extensions.gin_trgm_ops);

-- --- images ------------------------------------------------------------------

create table public.product_images (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete cascade,
  url        text not null,
  alt_text   text,
  sort_order integer not null default 0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger product_images_set_updated_at
  before update on public.product_images
  for each row execute function public.set_updated_at();

create index product_images_product_id_idx on public.product_images (product_id, sort_order);

-- Exactly one primary per product, enforced by the database rather than by
-- whichever admin form happens to be writing.
create unique index product_images_one_primary_idx
  on public.product_images (product_id)
  where is_primary;

-- --- variants ----------------------------------------------------------------

create table public.product_variants (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references public.products (id) on delete cascade,
  -- Text, not numeric: UK 8.5, EU 42, and kids' sizes all have to fit.
  size           text not null,
  color          text not null,
  color_hex      text check (color_hex is null or color_hex ~* '^#[0-9a-f]{6}$'),
  sku            text not null unique,
  price_override bigint check (price_override > 0),
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- One row per size/colour of a product. Two rows for UK 9 Black would split
  -- the stock count and make "only 2 left" wrong.
  constraint product_variants_unique_combo unique (product_id, size, color)
);

create trigger product_variants_set_updated_at
  before update on public.product_variants
  for each row execute function public.set_updated_at();

create index product_variants_product_id_idx on public.product_variants (product_id);
-- Powers the "in stock only" filter and the low-stock alert on the dashboard.
create index product_variants_in_stock_idx on public.product_variants (product_id)
  where is_active and stock_quantity > 0;

-- --- collections -------------------------------------------------------------

create table public.collections (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  description text,
  image_url   text,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger collections_set_updated_at
  before update on public.collections
  for each row execute function public.set_updated_at();

create table public.collection_products (
  id            uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.collections (id) on delete cascade,
  product_id    uuid not null references public.products (id) on delete cascade,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint collection_products_unique unique (collection_id, product_id)
);

create trigger collection_products_set_updated_at
  before update on public.collection_products
  for each row execute function public.set_updated_at();

create index collection_products_collection_idx on public.collection_products (collection_id, sort_order);
create index collection_products_product_idx    on public.collection_products (product_id);
