-- The `shipping` settings row exists after a replay from empty, and it holds
-- the owner's numbers, not the seed's memory of them.
--
-- `src/lib/shipping/settings.ts` requires `free_above_paise` and
-- `prepaid_estimate_fee_paise` and throws `ShippingSettingsUnavailableError`
-- without them — deliberately, because the constants it used to fall back to
-- had drifted from the live shop (Batch 2, the ₹2,499 that was really ₹6,499).
-- But no migration ever *created* the row those fields live in: it reached
-- production through the admin settings form, and a database rebuilt from this
-- directory answered 500 on every page until `npm run seed` happened to write
-- one — a stale one. The seed's copy carried the pre-Phase-8 shape: the ₹2,499
-- threshold from two phases ago, plus `fallback_fee_paise` and the three dead
-- `cod_advance_*` keys that `20260809110100` exists to delete. Rebuilding
-- staging restored, by procedure, the exact keys the migrations delete —
-- see docs/staging.md §3c as it stood before Batch 3.
--
-- So the row becomes a migration's responsibility and the seed no longer
-- carries a `shipping` entry at all (removed from `scripts/seed-data.ts` in the
-- same change). One writer, and it is this directory.
--
-- The three values are the owner's own, not inventions:
--   free_above_paise 649900        confirmed by the owner, live on production
--   prepaid_estimate_fee_paise 19900   the owner's fallback figure, the same
--                                      number 20260809110100 migrates from
--                                      `fallback_fee_paise.razorpay`
--   cod_enabled true               the shop sells Pay on Delivery today
--
-- Everything else the reader treats as optional stays absent on purpose. An
-- absent cap means "no cap", an absent minimum means "no minimum", an absent
-- wallet threshold means "the owner has not chosen one" — each surfaces as an
-- empty box at /admin/settings rather than as somebody else's number.
--
-- `where not exists` rather than an upsert: on any database where the owner has
-- ever touched settings, their row — whatever shape it is in, the renames run
-- earlier in this sequence — is the truth, and this migration must not move it.
insert into public.site_settings (key, value, description, is_public)
select
  'shipping',
  jsonb_build_object(
    'free_above_paise', 649900,
    'prepaid_estimate_fee_paise', 19900,
    'cod_enabled', true
  ),
  'Free-delivery threshold, the prepaid outage estimate, and the Pay on '
    || 'Delivery master switch. Rates are never stored here — they come from '
    || 'the courier per order. Editable at /admin/settings; fields left unset '
    || 'are unset on purpose and render as empty boxes there.',
  false
where not exists (
  select 1 from public.site_settings where key = 'shipping'
);
