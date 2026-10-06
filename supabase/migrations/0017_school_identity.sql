-- =============================================================================
-- School identity in `settings` — one source of truth
--
-- ── The drift this fixes ─────────────────────────────────────────────────────
--
-- The school name lived in two places that could disagree:
--
--   1. `settings['school.name']`, written by the Settings screen. Read by
--      `report-generate`, so it is what appears on a printed mark sheet.
--   2. `VITE_SCHOOL_*` in the frontend, compiled into the bundle. Read by the
--      sidebar masthead, the document title, the sign-in screen and the
--      landing page.
--
-- An administrator renaming the school on the Settings screen changed the
-- printed report and nothing else. The letterhead said one thing and the
-- sidebar said another, on the same sheet of paper.
--
-- The database wins, for one reason: `settings` is editable at runtime by
-- somebody who can sign in, whereas `VITE_*` needs a rebuild and a redeploy.
-- A school administrator is exactly the person who should be able to correct
-- their own affiliation number, and they cannot run a deploy.
--
-- `VITE_SCHOOL_*` is therefore demoted to a *fallback* for values the database
-- has not got, which keeps a fresh clone working before anyone opens Settings.
--
-- ── Why these keys and not a `school` table ──────────────────────────────────
--
-- Eight scalar strings that are only ever read as a set and never joined,
-- filtered or referenced from another row. A single-row `school` table would
-- buy referential integrity over rows that do not exist. `settings` is already
-- the application's configuration store and is already RLS-guarded.
--
-- ── RLS ──────────────────────────────────────────────────────────────────────
--
-- No change. `settings_read` allows any active signed-in user to select, which
-- is required — every teacher must see the school name on the sidebar and on
-- every printed sheet. `settings_write` still requires `settings:manage`.
-- =============================================================================

insert into public.settings (key, value) values
  ('school.short_name',    'Christ Church Co-Ed'),
  ('school.location',      'Gram Saliwada, Mandla Road, Jabalpur (M.P.), India'),
  ('school.authority',     'Board of Education, Church of North India, Jabalpur Diocese'),
  ('school.affiliation',   'C.B.S.E. Affiliation No. 1031217'),
  ('school.phone',         '+91 72250 91111'),
  ('school.email',         'cccssjalabur@gmail.com'),
  ('school.website',       'https://cccssj.in/')
on conflict (key) do update set value = excluded.value;

-- -----------------------------------------------------------------------------
-- `school.name` is left as it is on purpose.
--
-- It was seeded as 'Demo School' in 0003 and corrected by hand afterwards, so
-- re-seeding it here would silently revert whatever the administrator has since
-- typed. The other seven keys are new, so there is nothing to preserve.
--
-- The only guard added is a non-empty default for the case where the row is
-- missing entirely, which would otherwise render a blank letterhead.
-- =============================================================================

insert into public.settings (key, value)
values ('school.name', 'Christ Church Co-Ed School')
on conflict (key) do nothing;
