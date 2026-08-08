create table public.integration_tokens (
  provider     text primary key,
  token        text not null,
  expires_at   timestamptz not null,
  refreshed_at timestamptz not null default now()
);

alter table public.integration_tokens enable row level security;
-- No policies and no grants: `service_role` bypasses RLS, and every other role
-- is refused by the absence of a policy rather than by the wording of one.
revoke all on public.integration_tokens from anon, authenticated;

comment on table public.integration_tokens is
  'Cached third-party bearer tokens. In Postgres rather than module memory because '
  'a serverless instance is not a cache: it is discarded constantly, and several '
  'run concurrently, so a module-scoped token means logging in on most cold starts. '
  'Shiprocket''s login is rate-limited and its token is valid for 240 hours, so a '
  'per-instance cache would turn one login every ten days into one per instance. '
  'The token is a secret at rest here; the table is reachable only by service_role, '
  'which is the same trust level as the credentials that mint it.';

comment on column public.integration_tokens.expires_at is
  'When the provider says the token dies. The refresh is triggered well before '
  'this — see SHIPROCKET_REFRESH_MARGIN_MS — because a token that expires mid-request '
  'is a failed shipment, not a retry.';
