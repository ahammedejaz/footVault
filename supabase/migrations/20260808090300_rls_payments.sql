-- =============================================================================
-- 0018 · RLS — payments and payment events
--
-- Enabled with an admin-read policy and nothing else. There is deliberately no
-- anon or authenticated policy on either table, which means a customer reading
-- them gets zero rows, always.
--
-- That is not stinginess. A customer needs to know one thing about money —
-- whether their order is paid — and orders.payment_status says it in a word
-- they can act on. Everything in here is provider vocabulary, attempt history
-- and internal ids; exposing it would leak the shape of failed attempts (a
-- declined card is nobody else's business, including the customer's other
-- devices) and would hand an attacker a way to enumerate provider order ids.
--
-- The table-level grants are tightened as well as the policies. RLS decides
-- which rows; a GRANT decides whether the verb is available at all, and a
-- future policy added in haste cannot resurrect a privilege that was revoked
-- here. SELECT stays granted to `authenticated` because the admin policy is
-- evaluated as that role — take the grant away and admins read nothing.
-- =============================================================================

alter table public.payments       enable row level security;
alter table public.payment_events enable row level security;

create policy "admins read payments"
  on public.payments for select to authenticated
  using ((select public.is_admin()));

create policy "admins read payment events"
  on public.payment_events for select to authenticated
  using ((select public.is_admin()));

-- Anonymous callers have no business with either table under any policy.
revoke all on table public.payments       from anon;
revoke all on table public.payment_events from anon;

-- Signed-in callers keep SELECT (gated to admins by the policies above) and
-- lose every way of writing. Both tables are written by the server through the
-- service role, which these revokes do not touch.
revoke insert, update, delete, truncate, references, trigger
  on table public.payments from authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.payment_events from authenticated;
