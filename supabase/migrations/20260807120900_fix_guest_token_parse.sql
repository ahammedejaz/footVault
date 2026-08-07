-- =============================================================================
-- 0010 · Harden current_guest_token() against an empty header GUC
--
-- The original body was:
--
--   coalesce(current_setting('request.headers', true), '{}')::json ->> 'x-guest-token'
--
-- coalesce only replaces NULL. current_setting(..., true) returns NULL only if
-- the setting has never been set in the session; once it has been set and then
-- reset — which happens at the end of any transaction that used SET LOCAL, and
-- on a pooled connection between requests — it comes back as the empty string
-- instead. ''::json then raises 22P02, and because this function is called from
-- the carts and cart_items policies, that error surfaces as every cart query
-- failing rather than as an empty cart.
--
-- Found by running the guest-cart checks in docs/rls-tests.md twice on one
-- connection: the first pass passed, the second raised.
--
-- nullif() ahead of the coalesce turns the empty string back into NULL so the
-- '{}' default is actually reached.
-- =============================================================================

create or replace function public.current_guest_token()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.headers', true), ''),
      '{}'
    )::json ->> 'x-guest-token',
    ''
  );
$$;

comment on function public.current_guest_token() is
  'The x-guest-token request header, or null. Identifies an anonymous cart owner. Returns null rather than raising when the header GUC is unset or empty.';
