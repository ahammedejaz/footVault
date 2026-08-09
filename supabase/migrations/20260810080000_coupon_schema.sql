-- Coupons become redeemable: the schema half (§9F).
--
-- The `coupons` table has existed since Phase 3 with enable/disable
-- (`is_active`) and a schedule (`starts_at`/`expires_at`) already modelled —
-- what was missing is everything that makes a code *spendable*: who may use
-- it, how many times each customer may use it, and a ledger that can answer
-- "who used it, on which order, and was it given back". Additive throughout;
-- no existing row changes meaning.
--
-- ## The ledger is the load-bearing piece
--
-- `used_count` alone cannot enforce "once per customer", cannot release a code
-- when an order is cancelled, and cannot be audited. `coupon_redemptions`
-- records each grant against the order it paid for. `released_at` makes the
-- released state explicit rather than inferred, because redemption happens at
-- order *creation* — before payment — and the thirty-minute sweep cancels
-- abandoned orders. A customer whose order the shop (or the sweep) cancelled
-- gets their code back; see the sibling migration on
-- `cancel_order_with_restock`.
--
-- `unique (order_id)` is both "one coupon per order" and replay safety: a
-- retried insert against the same order collides instead of double-charging
-- the coupon.
--
-- ## The discount split becomes self-proving
--
-- 9E added `orders.prepaid_discount` inside `discount_total`; this adds the
-- coupon part and the CHECK that binds them. Same trick as
-- `orders_advance_balance_sums`: the database refuses a row whose parts do not
-- add up, so no read site has to trust arithmetic done elsewhere. Every
-- existing row has `discount_total = prepaid_discount` and gains
-- `coupon_discount = 0`, so the constraint holds over history by construction.
--
-- ## The cart carries the code, not the browser
--
-- `carts.coupon_code` is where a typed code waits between the bag and Place
-- Order. Held in the row rather than in client state so it survives
-- navigation, a refresh, and the cart/checkout handoff — and so the checkout
-- reads it from the same place the preview wrote it.

alter table public.coupons
  add column per_user_limit integer check (per_user_limit > 0),
  add column audience text not null default 'everyone'
    check (audience in ('everyone', 'specific_customers'));

comment on column public.coupons.per_user_limit is
  'How many orders one customer may redeem this on. Null = unlimited. '
  'Counted against non-released rows in coupon_redemptions.';
comment on column public.coupons.audience is
  'everyone, or specific_customers — the latter requires rows in coupon_customers.';

create table public.coupon_customers (
  coupon_id uuid not null references public.coupons (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  primary key (coupon_id, user_id)
);

comment on table public.coupon_customers is
  'Who a specific_customers coupon is for. Absence of a row is refusal.';

create table public.coupon_redemptions (
  id             uuid primary key default gen_random_uuid(),
  coupon_id      uuid not null references public.coupons (id),
  order_id       uuid not null references public.orders (id) on delete cascade,
  user_id        uuid references public.profiles (id) on delete set null,
  -- A snapshot, because the coupon may be renamed or deleted and the ledger
  -- still has to say what the customer typed.
  code           text not null,
  discount_paise bigint not null check (discount_paise >= 0),
  released_at    timestamptz,
  redeemed_at    timestamptz not null default now(),
  unique (order_id)
);

comment on table public.coupon_redemptions is
  'One row per coupon actually applied to an order. released_at set means the '
  'order was cancelled and the use was given back.';

-- The per-user-limit count: redemptions by (coupon, user) that still stand.
-- Written as a plain index rather than partial-on-released because the admin
-- redemption list wants the same key with history included.
create index coupon_redemptions_coupon_user_idx
  on public.coupon_redemptions (coupon_id, user_id);

-- Admin-only, matching `coupons`: RLS on, no policy grants anon or
-- authenticated anything, service_role bypasses. Customers can neither read
-- nor probe; codes cannot be enumerated.
alter table public.coupon_customers enable row level security;
alter table public.coupon_redemptions enable row level security;

create policy "Admins manage coupon customers"
  on public.coupon_customers for all
  using (public.is_admin()) with check (public.is_admin());

create policy "Admins manage coupon redemptions"
  on public.coupon_redemptions for all
  using (public.is_admin()) with check (public.is_admin());

-- The split on orders, and the CHECK that makes it arithmetic rather than
-- convention.
alter table public.orders
  add column coupon_discount bigint not null default 0
    check (coupon_discount >= 0);

alter table public.orders
  add constraint orders_discount_parts_sum
  check (discount_total = prepaid_discount + coupon_discount);

comment on column public.orders.coupon_discount is
  'The coupon''s part of discount_total, in paise. The CHECK binds '
  'discount_total = prepaid_discount + coupon_discount.';

-- Where a typed code waits between the bag and Place Order.
alter table public.carts add column coupon_code text;

comment on column public.carts.coupon_code is
  'The code the customer applied in the bag, pending authoritative '
  're-validation inside create_order_with_stock. Advisory until then.';
