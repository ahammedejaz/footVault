-- Phase 11 · Batch A — the reviews table grows up.
--
-- The table has existed since Phase 1 and been written by nobody. Audit 11A
-- found the grants wide open (`authenticated` held full DML, RLS the only
-- line) and the INSERT policy missing any purchase predicate: any signed-in
-- caller could POST one review per product over PostgREST, no parcel
-- required. The entry condition of the whole feature — a delivered order
-- containing the product — cannot be expressed in a policy without
-- subqueries on orders, and under post-moderation the policy's
-- `is_approved = false` pin makes client insert useless anyway.
--
-- So enforcement moves to where it can be real: **the server action holds
-- the service role and the delivered-order check; the client writes
-- nothing.** The revoke closes 11A.1 at source rather than out-guarding it,
-- and the dead-letter write policies are dropped in the same file so the
-- next reader is not misled about where enforcement lives.

-- ── 1 · the door ────────────────────────────────────────────────────────────

revoke insert, update, delete on public.reviews from anon, authenticated;

-- Dead letters once the grant is gone; dropped so nobody reasons from them.
drop policy if exists "customers write their own review" on public.reviews;
drop policy if exists "customers update their own review" on public.reviews;
drop policy if exists "customers delete their own review" on public.reviews;
-- The admin ALL policy's write half is equally dead (admin moderation goes
-- through the service role in server actions); its read half is recreated
-- below as SELECT-only, following inventory_movements' posture.
drop policy if exists "admins moderate reviews" on public.reviews;
create policy "admins read every review"
  on public.reviews for select to authenticated
  using ((select public.is_admin()));

-- ── 2 · what a review carries ───────────────────────────────────────────────

-- The reviewer's name, snapshotted at the moment of writing (first name
-- only, written by the action from profiles.full_name). Denormalised because
-- profiles is self-or-admin readable and the product page reads through the
-- cookieless anon static client — the client that is the reason
-- /product/[slug] does not wait on cookies before the LCP image. A review is
-- a statement made at a time by a person with a name then, the same way
-- order_items snapshots what was bought. Table is empty in both databases,
-- so NOT NULL needs no backfill.
alter table public.reviews add column display_name text not null;

-- Soft removal: the row survives with its reason, so a pattern of removals
-- stays visible later. A removed review disappears from the storefront (the
-- public read policy below) and stays readable to admins.
alter table public.reviews add column removed_at     timestamptz;
alter table public.reviews add column removed_reason text;
alter table public.reviews add column removed_by     uuid references public.profiles (id);

-- A removal without a reason is not a removal this shop performs.
alter table public.reviews add constraint reviews_removal_has_reason
  check (removed_at is null or removed_reason is not null);

-- The storefront never sees a removed review. Recreated rather than altered:
-- the old predicate was `is_approved` alone.
drop policy if exists "approved reviews are publicly readable" on public.reviews;
create policy "approved reviews are publicly readable"
  on public.reviews for select to anon, authenticated
  using (is_approved and removed_at is null);

-- ── 3 · aggregates as data ──────────────────────────────────────────────────

-- A sum and a count, not an average: the trigger stays in exact integer
-- arithmetic with no float drift, and the average is derived where it is
-- rendered. Both ride PRODUCT_FIELDS, so the listing pays zero extra round
-- trips (the catalog is two queries whatever the filters — audit 11A).
alter table public.products add column review_count integer not null default 0;
alter table public.products add column rating_sum   integer not null default 0;

-- Recomputed exactly rather than deltamaintained: one indexed aggregate per
-- write on a table whose write rate is human-scale, in exchange for a
-- trigger that cannot drift and needs no case analysis over approve /
-- remove / re-approve / delete orderings.
-- TG_OP branching, not a clever expression over OLD/NEW: in a PL/pgSQL row
-- trigger the absent record is *unassigned*, and referencing it raises even
-- inside an expression that looks null-safe. This repository has hit that
-- exact trap before (the record parse trap, Phase 10); each arm touches only
-- the record its event carries.
create or replace function public.reviews_refresh_aggregate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_products uuid[];
  v_product  uuid;
begin
  if tg_op = 'INSERT' then
    v_products := array[new.product_id];
  elsif tg_op = 'DELETE' then
    v_products := array[old.product_id];
  else
    v_products := array[new.product_id, old.product_id];
  end if;

  for v_product in select distinct unnest(v_products) loop
    update public.products p
       set review_count = agg.n,
           rating_sum   = agg.s
      from (
        select count(*)::integer as n,
               coalesce(sum(r.rating), 0)::integer as s
          from public.reviews r
         where r.product_id = v_product
           and r.is_approved
           and r.removed_at is null
      ) agg
     where p.id = v_product;
  end loop;
  return null;
end;
$$;

revoke execute on function public.reviews_refresh_aggregate() from public, anon, authenticated;

create trigger reviews_refresh_aggregate
  after insert or update or delete on public.reviews
  for each row execute function public.reviews_refresh_aggregate();

-- ── 4 · the reconciliation gate's query ─────────────────────────────────────

create or replace function public.reconcile_reviews()
returns table (
  product_id     uuid,
  stored_count   integer,
  actual_count   bigint,
  stored_sum     integer,
  actual_sum     bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id,
         p.review_count,
         count(r.id) filter (where r.is_approved and r.removed_at is null),
         p.rating_sum,
         coalesce(sum(r.rating) filter (where r.is_approved and r.removed_at is null), 0)
    from public.products p
    left join public.reviews r on r.product_id = p.id
   group by p.id, p.review_count, p.rating_sum
  having p.review_count <> count(r.id) filter (where r.is_approved and r.removed_at is null)
      or p.rating_sum <> coalesce(sum(r.rating) filter (where r.is_approved and r.removed_at is null), 0)
   order by p.id;
$$;

comment on function public.reconcile_reviews() is
  'Returns one row per product whose stored review aggregates disagree with '
  'the reviews table. An empty result is the pass condition — '
  'audit:reviews reports it as a number, mirroring reconcile_inventory().';

revoke execute on function public.reconcile_reviews() from anon, authenticated;
grant execute on function public.reconcile_reviews() to service_role;
