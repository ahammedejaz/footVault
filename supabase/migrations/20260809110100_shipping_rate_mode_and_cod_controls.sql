-- The four delivery controls the owner asked for in Phase 7 and never got, plus
-- the removal of the constant that produced the ₹150 on FV-2026-00571.
--
-- ## The rename, and why it is a rename rather than a second pair
--
-- `customer_delivery_fee_mode` / `customer_delivery_flat_paise` already did
-- roughly what the owner asked for under the names `shipping_rate_mode` /
-- `flat_shipping_fee`. Adding the requested pair beside the existing pair would
-- have left two settings that mean almost the same thing and drift apart the
-- first time one is edited — which is precisely the failure that produced the
-- ₹199-against-₹220 split between orders FV-2026-00487 and FV-2026-00488. So
-- the old keys are moved, not duplicated, and the old spellings are dropped.
--
-- ## `flat` now means no Shiprocket call at all
--
-- The old flat mode still quoted the courier and then ignored the answer for
-- pricing. The owner's requirement is that flat mode makes *no* Shiprocket call,
-- so a festival sale is a fixed price and not a fixed price plus an API
-- dependency. That has a consequence worth writing down: in flat mode the shop
-- does not know this PIN's serviceability, does not know whether a courier there
-- collects cash, and does not know the cash-collection fee. It sells anyway.
--
-- And it has a second consequence, which is what the deposit fields below are
-- for. The Pay-on-Delivery advance is `forward freight + RTO freight` quoted
-- live; with no quote there is no round trip, and an advance of nothing is
-- unsecured Pay on Delivery — the exact thing Phase 7 existed to remove. So flat
-- mode carries its own deposit rule, and **it is unset**. Until the owner sets
-- it, Pay on Delivery is refused in flat mode rather than collecting zero.
--
-- ## `fallback_fee_paise.cod` is deleted, not corrected
--
-- Order FV-2026-00571 carries a ₹150 cash-handling line that no courier ever
-- charged. It came from `src/lib/shipping/fee.ts` computing
-- `fallback_fee_paise.cod − fallback_fee_paise.razorpay` = ₹349 − ₹199 = ₹150
-- and presenting the difference between two numbers the owner typed as though
-- it were Shiprocket's `cod_charges`. The rule now is absolute: the
-- cash-handling line is Shiprocket's `cod_charges` or it is zero. With
-- `fallback_behaviour = refuse_cod` there is no longer any path that needs a COD
-- fallback rate, so the field is removed rather than left loaded.
--
-- The prepaid half survives under a name that says what it is. Prepaid still
-- sells when Shiprocket is unreachable, with the price labelled to the customer
-- as an estimate, because refusing to sell during a courier outage is worse than
-- mispricing a handful of orders.

update public.site_settings
set value = (value
      - 'customer_delivery_fee_mode'
      - 'customer_delivery_flat_paise'
      - 'fallback_fee_paise'
      -- Phase 7 replaced the advance rule and its report says these three left
      -- `site_settings` with it. They did not: they are still in the row on
      -- staging, and every one of them priced the deposit from what the
      -- *customer* was charged for delivery — the model that lost ₹182 on every
      -- refused parcel. Nothing reads them now, which is exactly what makes
      -- them dangerous: a plausible key with a plausible value, waiting for
      -- somebody to wire it back up.
      - 'cod_advance_mode'
      - 'cod_advance_minimum_paise'
      - 'cod_advance_fixed_paise')
  || jsonb_build_object(
       'shipping_rate_mode', coalesce(value ->> 'customer_delivery_fee_mode', 'live'),
       'flat_shipping_fee_paise',
         coalesce((value -> 'customer_delivery_flat_paise')::text::bigint, 0),

       -- What a prepaid customer is charged when there is no live quote. Shown
       -- to them as an estimate, never as a rate.
       'prepaid_estimate_fee_paise',
         coalesce((value -> 'fallback_fee_paise' -> 'razorpay')::text::bigint, 19900),

       -- Owner's decision 3, 2026-08-09: keep charging the cash-handling fee
       -- even when delivery itself is free. It is a real courier cost and it
       -- gives customers a reason to prepay. A setting rather than a constant
       -- because it is a pricing decision, and reversing it must not need a
       -- deploy.
       'waive_cod_fee_above_threshold', false,

       -- Owner's decision 4, 2026-08-09: no live quote means no Pay on
       -- Delivery. Prepaid is let through with the price labelled an estimate.
       -- `allow_all` is the other setting and it still requires a deposit rule
       -- below — there is no configuration of this shop that collects nothing.
       'fallback_behaviour', 'refuse_cod',

       -- The flat-mode deposit, UNSET. `multiplier` takes this many times the
       -- flat delivery fee; `fixed` takes the amount typed. Null means the owner
       -- has not chosen, and Pay on Delivery is refused in flat mode until they
       -- do. Deliberately not defaulted: any number here would be this file
       -- deciding what the shop collects against a return.
       'flat_cod_deposit_mode', null,
       'flat_cod_deposit_multiplier', null,
       'flat_cod_deposit_paise', null,

       -- Read by the admin dashboard's wallet warning. Unset means the
       -- dashboard says no threshold is configured rather than never warning.
       'wallet_low_balance_paise', null
     )
where key = 'shipping';
