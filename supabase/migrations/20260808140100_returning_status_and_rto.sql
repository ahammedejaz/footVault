-- Phase 7. A parcel coming back is a state of its own.
--
-- `returned` already existed and means "we have it back and it is done".
-- `returning` is the gap between the courier saying RTO and the parcel being in
-- the shop's hands, and the gap matters because parcels are lost and damaged on
-- the way back: restocking on a tracking event alone silently invents stock.

alter type public.order_status add value if not exists 'returning' before 'returned';

alter type public.inventory_movement_reason add value if not exists 'rto_return';
alter type public.inventory_movement_reason add value if not exists 'rto_writeoff';
