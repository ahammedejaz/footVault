-- `order_status_history.customer_note` — one field per audience.
--
-- The customer of FV-2026-00623 currently reads `rfnd_TNeaZX8YweRyFi`,
-- `cancelled_before_dispatch` and the word "webhook" in the timeline on their own
-- order page. None of that is a bug in the strings: it is one column serving two
-- readers. `note` is written by engineers for an audit trail — a Razorpay refund
-- id is exactly the right thing to record when a payment is disputed six months
-- later — and `src/lib/queries/orders.ts` passes it through unfiltered to a
-- component that prints it.
--
-- ## Why a column and not a translation layer
--
-- A map from internal text to customer text is a second place the truth lives,
-- and it goes stale silently the first time somebody edits a note string: the
-- lookup misses, and the customer sees the raw audit line again with nothing
-- failing. A nullable column makes "this event has nothing to say to a customer"
-- the default and the safe state — the timeline falls back to the status label
-- from `ORDER_STATUS_COPY`, which is already good copy.
--
-- `note` keeps its exact meaning and every existing value. What changes is that
-- it stops being customer-visible.

alter table public.order_status_history
  add column if not exists customer_note text;

comment on column public.order_status_history.note is
  'Internal audit trail. Provider ids, reason codes and mechanism belong here. '
  'Never rendered to a customer — see customer_note.';

comment on column public.order_status_history.customer_note is
  'What this event says to the customer, in their own register, or null when it '
  'has nothing to say. Null renders as the status label alone, which is the '
  'safe default: a missing sentence is a clean timeline, an internal one is a '
  'customer reading a Razorpay refund id.';
