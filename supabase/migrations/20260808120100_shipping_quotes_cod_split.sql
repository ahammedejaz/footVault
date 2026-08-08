-- The delivery fee gains a breakdown, because the customer is now shown one.
--
-- `fee_paise` stays exactly what it was — the total charged for delivery — so
-- nothing that reads it changes meaning. What is new is the split: the forward
-- leg a prepaid order would have paid, and the Pay-on-Delivery extra that covers
-- the return leg on a refused parcel.
--
-- The owner's condition for keeping the COD surcharge was that it appear as an
-- explicit named line rather than as an unexplained difference between two
-- totals. A customer comparing prepaid against Pay on Delivery has to be able to
-- see the ₹21 and point at it. That is only possible if the split is stored on
-- the quote the customer was shown, not recomputed later from a rate that has
-- since moved.
alter table public.shipping_quotes
  add column shipping_fee_paise bigint not null default 0
    check (shipping_fee_paise >= 0),
  add column cod_handling_paise bigint not null default 0
    check (cod_handling_paise >= 0);

-- Existing rows predate the split. Their whole fee was the forward leg for
-- prepaid; for COD it was forward plus return with no record of the boundary,
-- so it is attributed to shipping rather than invented.
update public.shipping_quotes set shipping_fee_paise = fee_paise;

alter table public.shipping_quotes
  add constraint shipping_quotes_fee_split
  check (shipping_fee_paise + cod_handling_paise = fee_paise);

comment on column public.shipping_quotes.cod_handling_paise is
  'The Pay-on-Delivery extra: the return leg the shop pays when a COD parcel is '
  'refused at the door. Rendered as its own line wherever a total is shown, '
  'never folded into the shipping fee. Always 0 for prepaid.';
