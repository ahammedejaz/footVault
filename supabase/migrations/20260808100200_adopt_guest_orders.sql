-- =============================================================================
-- 0025 · adopt_guest_orders — the account keeps what the guest bought
--
-- Security review E-3. The confirmation page invites a guest to create an
-- account. They accept, and lose the order they just paid for: the cart merge
-- reports a converted cart as "spent", /auth/callback drops the guest cookie,
-- and nothing ever moved the order onto the new account. `orders.user_id` stays
-- null and `orders.guest_token` keeps a token no browser holds any more. The
-- RLS guest policy needs a header that is gone and the customer policy needs a
-- `user_id` that was never set, so the order becomes readable by nobody.
--
-- This is the missing half. It runs in /auth/callback, in the same place and on
-- the same client as the cart merge, and for the same reason: that client is
-- the one moment a request carries both identities at once.
--
-- **SECURITY DEFINER, and this one genuinely needs it.** `authenticated` has no
-- UPDATE policy on `orders` and must not get one — a policy that let a customer
-- PATCH their own order rows over PostgREST would be a much larger hole than
-- the one being closed. So the write happens inside a function that owns the
-- privilege, and the function is built so the privilege cannot be aimed:
--
--   * **It takes no parameters at all.** There is nothing to spoof. The user
--     comes from auth.uid() and the token from public.current_guest_token(),
--     which reads the x-guest-token request header — the same header the cart
--     policies key on, forwarded from an httpOnly cookie the browser's own
--     JavaScript cannot read.
--   * Both of those are *request* facts, not *role* facts, so DEFINER does not
--     change what they return. That is precisely the difference from Phase 1's
--     guard_profile_role() bug: `current_user` resolves to the function owner
--     under DEFINER and the guard went silently inert. auth.uid() and the
--     headers GUC do not.
--   * It grants no capability the caller did not already have. Holding the
--     token already grants read access to those orders through the guest SELECT
--     policy; this converts one form of ownership into another. Somebody who
--     could not read an order before cannot adopt it now.
--   * `and user_id is null` means it can never take an order off an account
--     that already owns one.
--
-- search_path pinned, every name schema-qualified, execute revoked from public
-- and anon.
-- =============================================================================

create or replace function public.adopt_guest_orders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid := (select auth.uid());
  v_token text := (select public.current_guest_token());
  v_count integer := 0;
begin
  -- Not an error. A customer signing in from a browser that never checked out
  -- as a guest has nothing to adopt, and that is the common case.
  if v_user is null or v_token is null then
    return 0;
  end if;

  update public.orders
     set user_id     = v_user,
         guest_token = null
   where guest_token = v_token
     and user_id is null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.adopt_guest_orders() is
  'Moves every order held by the caller''s x-guest-token onto the caller''s account, clearing the token. Takes no parameters: the user comes from auth.uid() and the token from the request header, so neither can be supplied. SECURITY DEFINER because authenticated has no UPDATE policy on orders and must not get one.';

revoke execute on function public.adopt_guest_orders() from public, anon;
grant execute on function public.adopt_guest_orders() to authenticated;
