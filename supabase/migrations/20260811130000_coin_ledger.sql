-- Phase 11 · Batch B — Vault Coins, the earning half.
--
-- A coin is a TENDER the shop owes, not a discount (owner's ruling,
-- 2026-08-11), and it gets the discipline the other money in this schema
-- gets: a ledger and no balance column anywhere — balance is sum(delta),
-- history is rows, and when it goes wrong the rows say how. The grants
-- follow inventory_movements, not coupon_redemptions (audit 11E.3): the
-- ensure_rls trigger enables RLS on new tables but does NOT revoke the
-- default DML grants — that is exactly how reviews came to be writable —
-- so the revoke here is explicit.
--
-- Coins are only ever created by a delivered order. No signup bonus, no
-- referral, nothing a free row in auth.users can trigger — accounts cost
-- nothing (11D.1) and a per-account grant is farmable at account speed.

-- ── 1 · the ledger ──────────────────────────────────────────────────────────

create type public.coin_reason as enum
  ('earned', 'redeemed', 'reversed', 'expired', 'adjusted');

create table public.coin_transactions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id),
  -- Signed, never zero. Positive mints, negative settles/reverses/expires.
  delta       integer not null check (delta <> 0),
  reason      public.coin_reason not null,
  order_id    uuid references public.orders (id),
  -- The admin behind an 'adjusted' row. Null for machine-written rows.
  actor       uuid references public.profiles (id),
  note        text,
  -- Set on 'earned' only: expiry is a property of the coins at the moment
  -- they are minted, so FIFO consumption and the expiry cron need no date
  -- arithmetic invented later.
  expires_at  timestamptz,
  created_at  timestamptz not null default now()
);

comment on table public.coin_transactions is
  'The Vault Coins ledger. No balance column exists anywhere: balance is '
  'sum(delta). Written only by SECURITY DEFINER functions and the service '
  'role — anon and authenticated hold no DML grant at all.';

-- THE idempotency. A delivery event replayed ten times inserts one earned
-- row and collides nine times; same for one reversal per cause. The same
-- trick coupon_redemptions.unique(order_id) uses — a database guarantee,
-- not an application one.
create unique index coin_transactions_once_per_order_reason
  on public.coin_transactions (order_id, reason)
  where order_id is not null;

-- The two reads that exist: a customer's own history, and FIFO by cohort.
create index coin_transactions_user_created_idx
  on public.coin_transactions (user_id, created_at desc);
create index coin_transactions_user_expiry_idx
  on public.coin_transactions (user_id, expires_at)
  where reason = 'earned';

alter table public.coin_transactions enable row level security;

revoke insert, update, delete, references, trigger, truncate
  on public.coin_transactions from anon, authenticated;

create policy "customers read their own coin history"
  on public.coin_transactions for select to authenticated
  using (user_id = (select auth.uid()));

create policy "admins read every coin transaction"
  on public.coin_transactions for select to authenticated
  using ((select public.is_admin()));

-- ── 2 · the account row — a lock target and a switch, never a balance ──────

create table public.coin_accounts (
  user_id        uuid primary key references public.profiles (id),
  -- Batch D's per-customer disable. Checked at credit AND at redemption.
  coins_disabled boolean not null default false,
  created_at     timestamptz not null default now()
);

comment on table public.coin_accounts is
  'One row per customer who has ever touched coins. NOT a balance — it is '
  'the row Batch C''s redemption takes FOR UPDATE (a sum cannot be locked), '
  'and the per-customer disable switch. Deliberately a visible row rather '
  'than an advisory lock, so the lock target is something a reader can see.';

alter table public.coin_accounts enable row level security;

revoke insert, update, delete, references, trigger, truncate
  on public.coin_accounts from anon, authenticated;

create policy "customers see their own coin account"
  on public.coin_accounts for select to authenticated
  using (user_id = (select auth.uid()));

create policy "admins see every coin account"
  on public.coin_accounts for select to authenticated
  using ((select public.is_admin()));

-- ── 3 · while in the neighbourhood: 11E.3's one-liner ──────────────────────

-- coupon_redemptions kept the default DML grants; RLS was the only line.
-- Nothing was exploitable, but the ledger posture is the right one and this
-- phase is already in the file's neighbourhood.
revoke insert, update, delete, references, trigger, truncate
  on public.coupon_redemptions from anon, authenticated;

-- ── 4 · the loyalty settings row — every number unset, loudly ──────────────

-- Private: the earn rate and (later) the coin value are margin. The
-- storefront's "what a coin is worth" copy is rendered server-side from
-- this row; nothing anon-readable carries it. An empty object IS the
-- resting state: no number here was invented tonight, and until the owner
-- sets earn_rupees_per_coin the programme demonstrably earns nothing —
-- credit_order_coins answers 'rate_unset' and /admin/loyalty (Batch D)
-- says so in a sentence.
insert into public.site_settings (key, value, is_public)
values ('loyalty', '{}'::jsonb, false)
on conflict (key) do nothing;

-- ── 5 · earning ────────────────────────────────────────────────────────────

/**
 * Credit a delivered order's coins. Idempotent on the unique index; safe to
 * call on every delivered transition, every replay, every reconciliation.
 *
 * The base is what was actually paid for the GOODS:
 * subtotal − discount_total. Never shipping, never the cash-handling fee
 * (a customer must not earn on freight), and under the tender ruling
 * discount_total is coupon + prepaid and nothing else, so the two-term
 * expression stays clean. Coins spent on the order (Batch C) do NOT reduce
 * the earn base: they settled a debt, they did not reduce the price.
 *
 * Trusts only orders.delivered_at — the evidence field. No delivered_at,
 * no coins, whatever the status says.
 */
create or replace function public.credit_order_coins(p_order_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order    record;
  v_disabled boolean;
  v_rate     integer;
  v_months   integer;
  v_coins    integer;
  v_expires  timestamptz;
begin
  select o.user_id, o.subtotal, o.discount_total, o.delivered_at
    into v_order
    from public.orders o
   where o.id = p_order_id;
  if not found then
    return 'not_found';
  end if;

  if v_order.delivered_at is null then
    return 'not_delivered';
  end if;

  -- Guests earn nothing (decision D7), and signing up later does not
  -- backfill: adoption is by cookie token, never by email.
  if v_order.user_id is null then
    return 'no_user';
  end if;

  insert into public.coin_accounts (user_id)
  values (v_order.user_id)
  on conflict (user_id) do nothing;

  select a.coins_disabled into v_disabled
    from public.coin_accounts a where a.user_id = v_order.user_id;
  if v_disabled then
    return 'disabled';
  end if;

  select nullif((s.value ->> 'earn_rupees_per_coin'), '')::integer
    into v_rate
    from public.site_settings s where s.key = 'loyalty';
  if v_rate is null or v_rate <= 0 then
    -- The owner has not set the rate. The programme earns nothing and the
    -- admin panel says so; crediting at a guessed rate is the one thing
    -- this shop never does with a business number.
    return 'rate_unset';
  end if;

  v_coins := floor((v_order.subtotal - v_order.discount_total)::numeric
                   / (v_rate * 100));
  if v_coins <= 0 then
    return 'nothing_to_credit';
  end if;

  -- Expiry runs from DELIVERY, not from whenever this function managed to
  -- run — a replay a week late must mint the same coins with the same
  -- lifetime. Unset months = no expiry on this cohort, and /admin/loyalty
  -- names that state; a lifetime is a business number nobody invents here.
  select nullif((s.value ->> 'coin_expiry_months'), '')::integer
    into v_months
    from public.site_settings s where s.key = 'loyalty';
  v_expires := case
    when v_months is null or v_months <= 0 then null
    else v_order.delivered_at + make_interval(months => v_months)
  end;

  insert into public.coin_transactions
    (user_id, delta, reason, order_id, expires_at,
     note)
  values
    (v_order.user_id, v_coins, 'earned', p_order_id, v_expires,
     'Earned on delivery')
  on conflict (order_id, reason) where order_id is not null
  do nothing;

  if not found then
    return 'already_credited';
  end if;
  return 'credited';
end;
$$;

revoke all on function public.credit_order_coins(uuid)
  from public, anon, authenticated;
grant execute on function public.credit_order_coins(uuid) to service_role;

-- ── 6 · reversal — the exploit the brief names, closed in the design ───────

/**
 * Order ₹10,000, earn 100 coins, get the money back, keep the coins — this
 * function is the close. One implementation, called from BOTH triggers that
 * can undo a delivered sale (the delivered→returned transition, and a
 * processed refund on a delivered order), because two implementations of
 * "undo this money" is how they drift.
 *
 * Idempotent on the same unique index: one reversal per order, however many
 * hooks fire on the same order in whatever sequence.
 *
 * THE BALANCE MAY GO NEGATIVE HERE, AND THAT IS CORRECT. A customer who
 * earned 100, spent 100, then got a refund genuinely owes 100. Batch C's
 * redemption constraint forbids a REDEMPTION taking a balance below zero;
 * a reversal is a different rule, and conflating them would either allow
 * the exploit or block the honest reversal. Batch D surfaces negative
 * balances as an abuse signal.
 */
create or replace function public.reverse_order_coins(
  p_order_id uuid,
  p_reason   text,
  p_actor    uuid default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_earned record;
begin
  select t.user_id, t.delta into v_earned
    from public.coin_transactions t
   where t.order_id = p_order_id and t.reason = 'earned';
  if not found then
    return 'nothing_to_reverse';
  end if;

  insert into public.coin_transactions
    (user_id, delta, reason, order_id, actor, note)
  values
    (v_earned.user_id, -v_earned.delta, 'reversed', p_order_id, p_actor,
     coalesce(p_reason, 'Order came undone'))
  on conflict (order_id, reason) where order_id is not null
  do nothing;

  if not found then
    return 'already_reversed';
  end if;
  return 'reversed';
end;
$$;

revoke all on function public.reverse_order_coins(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.reverse_order_coins(uuid, text, uuid)
  to service_role;
