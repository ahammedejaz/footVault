-- 0028 · Every inbound email we have seen, so none is forwarded twice
--
-- Resend Inbound is enabled on the ROOT domain, so mail to any address
-- @footvault.in is accepted and lands in the Resend dashboard — which nobody
-- reads. The forwarding webhook exists to move it to a real mailbox. This table
-- is what stops one message arriving there five times.
--
-- ## Why the key is the email and not the delivery
--
-- Resend signs webhooks with Svix, and `svix-id` identifies the *delivery*. It
-- is the obvious key and it is the weaker one, for exactly the reason recorded
-- in 20260808090800_payment_event_id_meaning.sql about Razorpay's header: a
-- redelivery — automatic on non-2xx, or fired by hand from the dashboard —
-- carries a new delivery id for the same message. Keyed on `svix-id`, that
-- second delivery is a fresh event and the customer's mail is forwarded again.
--
-- `data.email_id` names the *message*. Two deliveries of one email collapse
-- onto one row; two genuinely different emails stay distinct. It is the same
-- trick and the same reasoning, one provider along.
--
-- `svix_id` is still recorded, because it is the only thing that ties a row
-- here to a delivery attempt in Resend's dashboard when somebody is asking why
-- a message did not arrive.
--
-- ## Why forwarded_at is nullable and separate
--
-- The row is claimed *before* the forward is attempted, so a slow or duplicated
-- delivery cannot produce two sends. That means a claimed row is not a
-- forwarded row: `forwarded_at is null` with a `forward_error` is a message
-- that was accepted and never reached the mailbox, and it is the only durable
-- trace of that. Without the split, a failed forward is indistinguishable from
-- a successful one and the failure is invisible — the shape of bug this
-- codebase keeps finding in its own webhooks.
--
-- Nothing here stores the message body. The body lives at Resend for its
-- retention period and is fetched on demand; copying a customer's email into
-- our database would make an inbox out of a table nobody intended to be one,
-- and put personal correspondence in every future backup.
-- =============================================================================

create table public.inbound_emails (
  -- Resend's id for the received message. The idempotency key: a 23505 on
  -- insert means this email is already claimed by an in-flight or finished
  -- delivery, and the correct answer is 200 with no second forward.
  email_id      uuid primary key,
  -- The Svix delivery id that claimed it. Not unique: a redelivery of the same
  -- message is expected and is precisely what this table absorbs.
  svix_id       text,
  -- Envelope only, for support. "Did anything arrive from this customer, and
  -- did we forward it" is the whole question this table answers.
  from_address  text,
  to_addresses  text[],
  subject       text,
  received_at   timestamptz not null default now(),
  -- Set only when the provider has accepted the forward. Null with an error set
  -- means the mail reached us and never reached the mailbox.
  forwarded_at  timestamptz,
  forward_error text
);

comment on table public.inbound_emails is
  'Every inbound email accepted by the Resend receiving webhook. email_id (Resend''s message id) is the idempotency key, not the Svix delivery id: a redelivery carries a new delivery id for the same message, so keying on the delivery would forward a customer''s mail twice. No message body is stored here — it stays at Resend and is fetched on demand.';
comment on column public.inbound_emails.forwarded_at is
  'Null with forward_error set means the message was accepted and never reached the mailbox. That is the row a human looks for when a customer says they were ignored.';

-- The queue a human reads after a mail outage: accepted, never forwarded.
create index inbound_emails_unforwarded_idx
  on public.inbound_emails (received_at desc)
  where forwarded_at is null;

-- RLS on, no policies. Same posture as payment_events: only the service role
-- touches this table, and a table holding who has written to the shop is not
-- something an anon or authenticated client should be able to read at all. With
-- RLS enabled and no policy, every non-service-role select returns zero rows.
alter table public.inbound_emails enable row level security;
