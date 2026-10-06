-- =============================================================================
-- Rate limiting
--
-- Replaces the retired Worker's isolate-local `Map`, which was already
-- unreliable: Cloudflare runs many isolates, so a per-isolate counter could be
-- reset by routing a request elsewhere. Edge Functions have the same problem —
-- a module-level counter is per-instance, not per-user.
--
-- A Postgres table is shared by every instance, so the count is actually global.
-- That matters here for data integrity as much as abuse: marks entry is a write
-- endpoint, and a runaway autosave loop from a misbehaving client would overwrite
-- a teacher's work.
--
-- Fixed window, not sliding. A fixed window allows a 2× burst across a boundary;
-- the retired limits were equally coarse, and a token bucket would be more code
-- than this use case justifies.
-- =============================================================================

create table if not exists public.rate_limits (
  key         text        not null,
  window_start timestamptz not null,
  count       integer     not null default 1,
  reset_at    timestamptz not null,
  primary key (key, window_start)
);

-- Expiry, so the table cannot grow without bound. Housekeeping only; nothing
-- queries expired rows.
create index if not exists idx_rate_limits_reset_at on public.rate_limits (reset_at);

-- -----------------------------------------------------------------------------
-- consume_rate_limit
--
-- The increment is a single INSERT ... ON CONFLICT DO UPDATE, which Postgres
-- executes atomically. Two concurrent requests therefore both see a correct
-- count; a read-then-write would lose one of them and under-count.
--
-- Returns the new count and whether it is within the limit, so the caller can
-- report remaining quota rather than just yes/no.
-- -----------------------------------------------------------------------------
create or replace function public.consume_rate_limit(
  p_key             text,
  p_window_start    timestamptz,
  p_limit           integer,
  p_period_seconds  integer
)
returns table (count integer, allowed boolean, reset_at timestamptz)
language plpgsql
as $$
declare
  v_count   integer;
  v_reset   timestamptz;
begin
  v_reset := p_window_start + make_interval(secs => p_period_seconds);

  insert into public.rate_limits (key, window_start, count, reset_at)
  values (p_key, p_window_start, 1, v_reset)
  on conflict (key, window_start)
    do update set count = public.rate_limits.count + 1
  returning public.rate_limits.count into v_count;

  -- This still increments past the limit rather than refusing the insert, so the
  -- counter reflects true usage. A caller that only ever sees "denied" would
  -- never learn it had been hammering an endpoint.
  return query
    select v_count,
           v_count <= p_limit,
           v_reset;
end;
$$;

-- -----------------------------------------------------------------------------
-- Cleanup
--
-- Call from a scheduled job or pg_cron:
--   select public.prune_rate_limits();
--
-- Deletes windows that have already expired. `reset_at` is indexed, so this stays
-- cheap as the table grows.
-- -----------------------------------------------------------------------------
create or replace function public.prune_rate_limits()
returns integer
language plpgsql
as $$
declare
  removed integer;
begin
  delete from public.rate_limits where reset_at < now() - interval '1 day';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS
--
-- No policies. The table is reached only through `consume_rate_limit`, which runs
-- as the service role from the Edge Function. Revoking direct access means a
-- caller cannot clear its own limit by deleting the row.
-- -----------------------------------------------------------------------------
alter table public.rate_limits enable row level security;

revoke all on table public.rate_limits from anon, authenticated;