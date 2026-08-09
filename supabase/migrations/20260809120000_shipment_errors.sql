-- Why Shiprocket refused, kept where the owner can read it tomorrow.
--
-- Until now the only place a fulfilment failure existed was a toast. The five
-- actions in `src/lib/actions/admin/shipping.ts` returned `outcome.message` —
-- Shiprocket's own sentence, the useful one, "Wrong Pickup location entered" or
-- "insufficient balance" — straight into `toast.failed()` and nowhere else. It
-- was gone on reload, gone on a second admin opening the same order, and gone
-- by the time anybody asked why the parcel never went out. The owner was left
-- pressing a button that said nothing except that it had not worked.
--
-- ## Why this is a table and not four columns on `shipments`
--
-- The obvious home is `public.shipments`, and it was rejected for two reasons
-- that only show up when you follow the code out of this schema.
--
-- **The create step deliberately deletes its own row on failure.** See
-- `createShipment` in `src/lib/shipping/fulfilment.ts`: the row is inserted
-- *before* the API call, holding `status = 'creating'`, because `unique
-- (order_id)` can only serialise two simultaneous presses if both try to write
-- before either calls Shiprocket. Calling first and inserting after would let
-- both through and create two real orders in the panel, and no constraint can
-- undo that. The price of that ordering is a row left behind when the call
-- fails, which is why the failure path clears it. Columns on that row would be
-- deleted by the very failure they exist to record.
--
-- The alternative was to stop deleting and mark the row `status = 'failed'`
-- instead. That was tried on paper and abandoned, because the row is not
-- private to the admin: `trackingFor()` in `src/lib/queries/orders.ts` reads
-- `shipments.status` for whoever owns the order and `order-detail.tsx` prints
-- it, so a Shiprocket refusal would have appeared on the *customer's* order page
-- as "Status: failed" — for an order that is fine, is paid for, and simply has
-- not been handed to a courier yet. It would also have cost the retry its
-- serialisation: with the row still there, two simultaneous retries both find
-- it and both call Shiprocket, which is the exact outcome the pre-insert exists
-- to prevent.
--
-- **The second reason is who may read it.** `shipments` carries a customer
-- policy — "customers read their own shipment" — so any column added there is
-- a column the customer can select. These messages are about the *shop's*
-- Shiprocket account: its wallet balance, its pickup addresses, its API user.
-- None of that is the customer's business, and RLS cannot hide one column from
-- a role that must see the rest of the row.
--
-- So the failure lives in its own table, keyed by the order rather than by the
-- shipment, which is what makes it survive the clear: deleting a shipment does
-- not touch it, and only deleting the order does.
--
-- One row per order, replaced wholesale by each new failure. It is "why the
-- last attempt did not work", not a log — the history of what was tried already
-- exists in `shipment_events`, and a second append-only table would be two
-- places to look. A successful step deletes the row, so its presence means
-- exactly one thing: something is wrong now.
-- **`if not exists`, and the reason is a mistake worth recording.**
--
-- This table was created on both the staging and the *production* project by
-- running the DDL directly rather than through the migration pipeline, so it
-- exists on two databases without a corresponding row in
-- `supabase_migrations.schema_migrations`. A later `supabase db push` would
-- otherwise stop here with "relation already exists" — on production — which is
-- a deployment failing for a reason that has nothing to do with the deployment.
--
-- Written idempotently so this migration produces the same end state whether it
-- meets a database that already has the table or one that does not. That is the
-- right property for it to have regardless; it is only being added now because
-- something went around the pipeline and made it necessary.
create table if not exists public.shipment_errors (
  order_id   uuid primary key references public.orders(id) on delete cascade,
  -- Which of the five steps: create, awb, pickup, documents, track. Text rather
  -- than an enum because `FulfilmentStep` is defined in TypeScript and a second
  -- definition here would be a second thing to keep in step.
  step       text not null,
  -- Shiprocket's own sentence, stored exactly as it was received and rendered
  -- to the owner verbatim. Never rewritten into house voice: "Wrong Pickup
  -- location entered" names the field to fix, and any paraphrase we invent is a
  -- paraphrase of an error we have not seen before.
  message    text not null,
  -- The whole response body. The parsed message is what we believed it said;
  -- this is what we were told, and only one of those is evidence when the
  -- support ticket comes back a fortnight later.
  detail     jsonb,
  failed_at  timestamptz not null default now()
);

comment on table public.shipment_errors is
  'Why the last fulfilment attempt for an order failed, in Shiprocket''s own '
  'words. Keyed by order rather than by shipment so it survives the create '
  'step deleting its half-made shipments row. One row per order, replaced by '
  'the next failure and deleted by the next success.';

alter table public.shipment_errors enable row level security;

-- Admins only, at the database rather than in the action that writes it. There
-- is deliberately no customer policy: these messages describe the shop's
-- Shiprocket account, not the customer's parcel.
-- Dropped first for the same reason the table is `if not exists`: `create
-- policy` has no idempotent form, and this may meet a database where the
-- out-of-band DDL already created it.
drop policy if exists "admins manage shipment errors" on public.shipment_errors;
create policy "admins manage shipment errors" on public.shipment_errors
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

revoke all on public.shipment_errors from anon, authenticated;
grant select, insert, update, delete on public.shipment_errors to authenticated;
