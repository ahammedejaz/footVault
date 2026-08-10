-- Which rule chose this parcel's courier, and why.
--
-- ## Why record it
--
-- The finding behind `courier_selection_mode` is that Shiprocket's recommended
-- courier scored worst of the available set on all three of `SLA_Adherence`,
-- `rto_performance` and `tracking_performance`, on both lanes tested. The shop
-- can now choose differently — but a choice whose consequences are not
-- observable is a preference, not a decision.
--
-- With these two columns the question "did picking best-rated actually reduce
-- returns?" is answerable by joining shipments to their outcomes. Without them
-- the only record of why a courier was used is whatever the setting happened to
-- say at the time, which is exactly the value that changes when somebody is
-- trying to find out whether changing it helped.
--
-- `courier_selection_reason` is the sentence the selector produced — "Best
-- rated (90) within 10% of the cheapest", "Cheapest of 4". It is denormalised
-- prose on purpose: it captures the *inputs* as they were, including the
-- tolerance and the score, neither of which is recoverable later from the mode
-- alone.
--
-- Both nullable. Existing shipments were assigned before any of this existed
-- and their courier was chosen by Shiprocket; null means "not recorded" rather
-- than "Shiprocket", because inventing a mode for historical rows would put
-- fabricated evidence into the one table meant to answer the question.
alter table public.shipments
  add column courier_selection_mode text
    check (
      courier_selection_mode is null
      or courier_selection_mode in ('cheapest', 'shiprocket', 'best_rated')
    ),
  add column courier_selection_reason text;

comment on column public.shipments.courier_selection_mode is
  'Which rule picked the courier: cheapest, shiprocket or best_rated. Null for '
  'shipments created before Phase 10, and for any where the selector could not '
  'run — never backfilled, because a guessed mode is fabricated evidence in the '
  'table that exists to review the choice.';

comment on column public.shipments.courier_selection_reason is
  'The selector''s own sentence, capturing the inputs as they were — the '
  'tolerance in force and the score of the courier chosen, neither of which is '
  'recoverable from the mode alone once the setting changes.';
