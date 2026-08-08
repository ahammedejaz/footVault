-- Same posture as `payments`: a customer needs to know their order is refunded,
-- which `orders.payment_status` says in one word. Everything here is provider
-- vocabulary, internal ids and the shop's own deduction arithmetic.
alter table public.refunds enable row level security;

create policy "admins read refunds" on public.refunds
  for select to authenticated
  using ((select public.is_admin()));

revoke all on public.refunds from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.refunds from authenticated;
-- SELECT stays: the admin policy above is evaluated as this role.
grant select on public.refunds to authenticated;
