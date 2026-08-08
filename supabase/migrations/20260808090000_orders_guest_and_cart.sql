-- =============================================================================
-- 0015 · Orders: reaching one without an account, and converting a cart once
--
-- Three things checkout needs from the orders table that Phase 4 had no reason
-- to give it.
--
-- 1. guest_token. A guest has no JWT, so `user_id = auth.uid()` cannot describe
--    "my order". The same opaque cookie that already names their cart names
--    their order, forwarded to PostgREST as the x-guest-token header and read
--    by public.current_guest_token(). It has to be the token and not the order
--    number: order numbers come from a sequence, so FV-2026-00042 is one
--    keystroke away from FV-2026-00043 and anyone could walk the whole book.
--
-- 2. cart_id, with a *unique* partial index. This is the double-submit guard.
--    A cart converts to at most one order, enforced by the database rather than
--    by hoping the browser only posts once — a double-tap on "Place order", a
--    back button, or a retried server action all end up at the same index.
--    ON DELETE SET NULL rather than cascade: a purge of old carts must never
--    take orders with it.
--
-- 3. stock_restored_at. Stock is claimed when the order is written, so
--    cancelling has to give it back — exactly once. Without a marker, two
--    cancellations (a webhook and an admin, say) restock twice and invent
--    inventory. See public.cancel_order_with_restock().
--
-- payment_reference is for support: the provider id a customer reads off their
-- bank statement, denormalised onto the order so looking it up is one query and
-- not a join through a table nobody outside the server can read.
-- =============================================================================

alter table public.orders
  add column guest_token       text,
  add column cart_id           uuid references public.carts (id) on delete set null,
  add column payment_reference text,
  add column stock_restored_at timestamptz;

comment on column public.orders.guest_token is
  'Bearer token identifying a guest who placed this order, matched against public.current_guest_token(). Null once the order belongs to an account.';
comment on column public.orders.cart_id is
  'The cart this order was made from. Unique where not null, so one cart converts at most once.';
comment on column public.orders.payment_reference is
  'The provider payment id, denormalised for support lookups. Authoritative payment state lives in public.payments.';
comment on column public.orders.stock_restored_at is
  'When cancellation gave this order''s units back to the catalog. Non-null means restocking already happened and must not repeat.';

-- The guest read policy filters on this column, so it is indexed for the same
-- reason every other policy column in this schema is.
create index orders_guest_token_idx on public.orders (guest_token)
  where guest_token is not null;

-- The guard itself. Partial, because most rows will eventually have a null
-- cart_id (carts get purged) and a null is not a conflict.
create unique index orders_one_per_cart_idx on public.orders (cart_id)
  where cart_id is not null;

create index orders_payment_reference_idx on public.orders (payment_reference)
  where payment_reference is not null;
