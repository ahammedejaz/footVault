-- =============================================================================
-- 0004 · Commerce
--
-- Carts are live and mutable; orders are immutable records. That distinction
-- drives the whole design here: order_items carry *snapshots* of the product
-- name, size, colour, SKU, price and image, so an order stays accurate after
-- the catalog moves on underneath it.
--
-- All money is integer paise.
-- =============================================================================

-- --- carts -------------------------------------------------------------------

create table public.carts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.profiles (id) on delete cascade,
  -- Opaque token in a cookie. Lets a guest keep a bag across page loads without
  -- an account, and is what the merge-on-login step looks up.
  guest_token text,
  status      public.cart_status not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- A cart belongs to exactly one owner. Both set would make merge-on-login
  -- ambiguous; neither set would make the cart unreachable.
  constraint carts_single_owner check (
    (user_id is not null and guest_token is null)
    or (user_id is null and guest_token is not null)
  )
);

create trigger carts_set_updated_at
  before update on public.carts
  for each row execute function public.set_updated_at();

-- One active cart per owner, so "get or create the cart" can never race into
-- two and split the customer's bag.
create unique index carts_one_active_per_user_idx
  on public.carts (user_id) where status = 'active' and user_id is not null;
create unique index carts_one_active_per_guest_idx
  on public.carts (guest_token) where status = 'active' and guest_token is not null;

create table public.cart_items (
  id         uuid primary key default gen_random_uuid(),
  cart_id    uuid not null references public.carts (id) on delete cascade,
  variant_id uuid not null references public.product_variants (id) on delete cascade,
  quantity   integer not null default 1 check (quantity > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Adding the same size twice bumps the quantity; it never creates a second
  -- line. The unique constraint is what makes that upsert safe.
  constraint cart_items_unique_variant unique (cart_id, variant_id)
);

create trigger cart_items_set_updated_at
  before update on public.cart_items
  for each row execute function public.set_updated_at();

create index cart_items_cart_id_idx    on public.cart_items (cart_id);
create index cart_items_variant_id_idx on public.cart_items (variant_id);

-- --- wishlist ----------------------------------------------------------------

create table public.wishlist_items (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wishlist_items_unique unique (user_id, product_id)
);

create trigger wishlist_items_set_updated_at
  before update on public.wishlist_items
  for each row execute function public.set_updated_at();

create index wishlist_items_user_id_idx on public.wishlist_items (user_id);

-- --- coupons -----------------------------------------------------------------
-- Declared before orders so orders.coupon_code has something to describe. Never
-- readable from the client: a customer must not be able to enumerate codes.

create table public.coupons (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  type            public.coupon_type not null,
  -- percent: 1-100. fixed: integer paise.
  value           bigint not null check (value > 0),
  min_order_value bigint not null default 0 check (min_order_value >= 0),
  max_discount    bigint check (max_discount > 0),
  usage_limit     integer check (usage_limit > 0),
  used_count      integer not null default 0 check (used_count >= 0),
  starts_at       timestamptz,
  expires_at      timestamptz,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint coupons_percent_in_range check (type <> 'percent' or value <= 100),
  constraint coupons_window_ordered check (
    starts_at is null or expires_at is null or expires_at > starts_at
  )
);

create trigger coupons_set_updated_at
  before update on public.coupons
  for each row execute function public.set_updated_at();

-- Codes are typed by humans, so lookup is case-insensitive. The index makes
-- `where upper(code) = upper($1)` an index scan rather than a seq scan.
create unique index coupons_code_upper_idx on public.coupons (upper(code));

-- --- orders ------------------------------------------------------------------

create table public.orders (
  id               uuid primary key default gen_random_uuid(),
  order_number     text not null unique default public.next_order_number(),
  -- Nullable: guests can check out. Set on account creation after the fact.
  user_id          uuid references public.profiles (id) on delete set null,
  status           public.order_status not null default 'pending',
  payment_status   public.payment_status not null default 'unpaid',
  payment_method   text not null default 'cod',
  -- Integer paise, all of them.
  subtotal         bigint not null check (subtotal >= 0),
  discount_total   bigint not null default 0 check (discount_total >= 0),
  shipping_fee     bigint not null default 0 check (shipping_fee >= 0),
  tax_total        bigint not null default 0 check (tax_total >= 0),
  grand_total      bigint not null check (grand_total >= 0),
  -- A snapshot, not a foreign key. The customer editing their address book must
  -- not silently rewrite where a shipped order went.
  shipping_address jsonb not null,
  contact_email    text,
  contact_phone    text,
  coupon_code      text,
  customer_note    text,
  placed_at        timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- The invoice has to add up. Enforced here so no server action can write a
  -- total that disagrees with its own line items.
  constraint orders_total_adds_up check (
    grand_total = subtotal - discount_total + shipping_fee + tax_total
  ),
  constraint orders_discount_within_subtotal check (discount_total <= subtotal)
);

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

create index orders_user_id_idx on public.orders (user_id, placed_at desc);
create index orders_status_idx  on public.orders (status, placed_at desc);
create index orders_placed_at_idx on public.orders (placed_at desc);

create table public.order_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.orders (id) on delete cascade,
  -- Nulled, not cascaded, if the variant is ever hard-deleted. The snapshot
  -- columns below are what the invoice actually renders from.
  variant_id   uuid references public.product_variants (id) on delete set null,
  product_id   uuid references public.products (id) on delete set null,
  product_name text not null,
  product_slug text,
  size         text not null,
  color        text not null,
  sku          text not null,
  unit_price   bigint not null check (unit_price >= 0),
  quantity     integer not null check (quantity > 0),
  line_total   bigint not null check (line_total >= 0),
  image_url    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint order_items_line_total_matches check (line_total = unit_price * quantity)
);

create trigger order_items_set_updated_at
  before update on public.order_items
  for each row execute function public.set_updated_at();

create index order_items_order_id_idx on public.order_items (order_id);
create index order_items_product_id_idx on public.order_items (product_id);

create table public.order_status_history (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders (id) on delete cascade,
  status     public.order_status not null,
  note       text,
  changed_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index order_status_history_order_id_idx
  on public.order_status_history (order_id, created_at desc);

-- --- reviews -----------------------------------------------------------------

create table public.reviews (
  id                   uuid primary key default gen_random_uuid(),
  product_id           uuid not null references public.products (id) on delete cascade,
  user_id              uuid not null references public.profiles (id) on delete cascade,
  rating               smallint not null check (rating between 1 and 5),
  title                text,
  body                 text,
  is_verified_purchase boolean not null default false,
  -- Moderated by default: nothing reaches the storefront unread.
  is_approved          boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint reviews_one_per_customer unique (product_id, user_id)
);

create trigger reviews_set_updated_at
  before update on public.reviews
  for each row execute function public.set_updated_at();

-- The product page reads only approved reviews for one product.
create index reviews_product_approved_idx on public.reviews (product_id, created_at desc)
  where is_approved;
create index reviews_user_id_idx on public.reviews (user_id);
-- The admin moderation queue.
create index reviews_pending_idx on public.reviews (created_at desc) where not is_approved;
