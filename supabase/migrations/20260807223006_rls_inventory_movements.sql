alter table public.inventory_movements enable row level security;

-- Admins read the ledger. Nobody writes it through PostgREST at all: the only
-- writer is the trigger, and a grant that does not exist cannot be exploited by
-- a policy mistake later. This is the same posture as payment_events.
create policy "inventory_movements_admin_read" on public.inventory_movements
  for select to authenticated
  using (public.is_admin());

revoke insert, update, delete on public.inventory_movements from anon, authenticated;
grant select on public.inventory_movements to authenticated;
