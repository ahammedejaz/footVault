alter table public.shipments enable row level security;
alter table public.shipment_events enable row level security;

-- Admins manage shipments through the panel, with the database checking
-- is_admin() on every row rather than trusting the action that called it.
create policy "admins manage shipments" on public.shipments
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "admins read shipment events" on public.shipment_events
  for select to authenticated
  using (public.is_admin());

-- A customer sees the tracking for their own order and nothing else.
--
-- owns_order() is the same SECURITY DEFINER helper the order pages use, so a
-- guest holding the right token and a signed-in customer are both covered by
-- one rule -- and neither can read another order's AWB by changing an id.
-- SELECT only: nothing a customer does moves a parcel.
create policy "customers read their own shipment" on public.shipments
  for select to authenticated, anon
  using (public.owns_order(order_id));

revoke insert, update, delete on public.shipment_events from anon, authenticated;
grant select on public.shipments to anon, authenticated;
grant select on public.shipment_events to authenticated;
