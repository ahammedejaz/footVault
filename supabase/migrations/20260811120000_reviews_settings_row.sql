-- Phase 11 · Batch A — the moderation switch, as a row.
--
-- Post-moderation is the owner's decision (plan D2, accepted): a review from
-- a delivered purchaser publishes immediately and can be removed afterwards,
-- with the reason recorded. The mechanism is a setting so reversing that
-- decision later is a toggle, never a migration — this row is the toggle.
--
-- Private (`is_public = false`), classified in SETTINGS_VISIBILITY with the
-- reason recorded there: the flag is read only by the review server action,
-- and publishing it would tell a bad actor whether fakes surface instantly.
--
-- `require_approval: false` is not an invented business number: it is the
-- decided moderation model, and the safe direction if it were wrong is one
-- click in /admin (a review wrongly held is an email; a model wrongly
-- guessed would have been this migration's fault — it is not guessed).

insert into public.site_settings (key, value, is_public)
values ('reviews', jsonb_build_object('require_approval', false), false)
on conflict (key) do nothing;
