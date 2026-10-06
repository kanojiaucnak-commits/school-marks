-- =============================================================================
-- Housekeeping that never got wired up
--
-- Two small jobs existed from the start but were never scheduled, because the
-- Cloudflare Worker that used to run them is gone:
--
--   1. `prune_rate_limits()` was called from the Worker's scheduled handler. With
--      no scheduler, the `rate_limits` table grew without bound — one row per
--      (key, window) — for the life of the deployment.
--
--   2. `export_jobs` rows in `QUEUED` were meant to be picked up by a queue
--      consumer that was never rebuilt. `export-generate` no longer produces them
--      (it runs inline and reaches COMPLETED or FAILED), but any row left over
--      from before that change would otherwise sit at QUEUED for ever, showing in
--      the exports list as work in progress that will never finish.
--
-- pg_cron does both. Enabling it needs the extension plus a schedule entry; the
-- job bodies are plain SQL so no Edge Function has to be awake for them to run.
-- =============================================================================

create extension if not exists pg_cron with schema extensions;

-- ── 1. Expire stale rate-limit buckets ───────────────────────────────────────
-- Daily. Windows are per-minute, so a day is far more than enough retention for
-- the throttling decision they feed, and anything older can never be consulted.
select cron.schedule(
  'prune-rate-limits',
  '17 3 * * *', -- 03:17 UTC: off the hour, so it does not pile onto everyone
  $$select public.prune_rate_limits();$$
)
where not exists (select 1 from cron.job where jobname = 'prune-rate-limits');

-- ── 2. Fail orphaned QUEUED exports ──────────────────────────────────────────
-- Marks them FAILED rather than deleting them, so the row still explains itself
-- in the exports list instead of vanishing. Deliberately not retried: these rows
-- have no payload — the parameters were never persisted for a job that never ran
-- — so there is nothing to re-execute.
update public.export_jobs
   set status = 'FAILED',
       error = coalesce(error, 'ORPHANED_QUEUE'),
       completed_at = coalesce(completed_at, now())
 where status = 'QUEUED';

-- Belt and braces: `export-generate` no longer writes QUEUED, and this check makes
-- it impossible for it to start doing so unnoticed.
alter table public.export_jobs
  drop constraint if exists export_jobs_status_check;
alter table public.export_jobs
  add constraint export_jobs_status_check
  check (status in ('RUNNING', 'COMPLETED', 'FAILED'));