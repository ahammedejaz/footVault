create table public.rate_limits (
  bucket       text primary key,
  count        integer not null default 0,
  window_start timestamptz not null default now()
);

alter table public.rate_limits enable row level security;
-- No policies at all, and no grants. Only service_role reaches this, and it does
-- so through consume_rate_limit() rather than by touching the table.
revoke all on public.rate_limits from anon, authenticated;

comment on table public.rate_limits is
  'Fixed-window counters for consume_rate_limit(). Postgres rather than module '
  'memory because a serverless instance is not the unit an attacker is limited to: '
  'per-instance counters reset on every cold start and are not shared between the '
  'concurrent instances one burst will spread across.';

create index rate_limits_window_idx on public.rate_limits (window_start);

create or replace function public.consume_rate_limit(
  p_bucket text,
  p_limit integer,
  p_window_seconds integer)
returns table (allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_start timestamptz;
begin
  -- One statement, so the read-modify-write cannot interleave. ON CONFLICT takes
  -- the row lock; a separate SELECT-then-UPDATE would let two concurrent requests
  -- both read count = limit - 1 and both be allowed.
  insert into public.rate_limits as rl (bucket, count, window_start)
  values (p_bucket, 1, now())
  on conflict (bucket) do update
     set count = case
           when rl.window_start < now() - make_interval(secs => p_window_seconds) then 1
           else rl.count + 1 end,
         window_start = case
           when rl.window_start < now() - make_interval(secs => p_window_seconds) then now()
           else rl.window_start end
  returning rl.count, rl.window_start into v_count, v_start;

  return query select
    v_count <= p_limit,
    greatest(p_limit - v_count, 0),
    greatest(ceil(extract(epoch from (v_start + make_interval(secs => p_window_seconds)) - now()))::integer, 0);
end;
$$;

comment on function public.consume_rate_limit(text, integer, integer) is
  'Fixed window, not sliding: a caller can spend a full allowance at the end of one '
  'window and another at the start of the next, so the true worst case is 2x the '
  'limit over a window boundary. Accepted deliberately — the alternative is a request '
  'log per caller, and this is a shock absorber rather than an authorization control. '
  'Nothing here is allowed to be the only thing standing between a caller and an action.';

revoke execute on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;
