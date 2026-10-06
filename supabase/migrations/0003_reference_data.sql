-- =============================================================================
-- Reference data
--
-- Roles and the permission matrix are seeded here rather than in application code
-- because `has_permission()` in 0002_rls.sql reads them from these tables. This
-- mirrors ROLE_PERMISSIONS in `shared/src/permissions.ts` exactly.
--
-- IF YOU EDIT ONE, EDIT THE OTHER. There is a test
-- (`shared/src/permissions.seed.test.ts`) that parses this file and asserts the
-- two stay in sync.
--
-- Idempotent — safe to re-apply.
-- =============================================================================

insert into public.roles (id, name, description) values
  ('role_admin',    'admin',
   'School administrator: full access to configuration, users and reports'),
  ('role_teacher',  'teacher',
   'Subject teacher: enters and submits marks for assigned classes only'),
  ('role_reviewer', 'reviewer',
   'Principal / reviewer: approves, returns and locks submitted marks')
on conflict (id) do update
  set description = excluded.description;

-- -----------------------------------------------------------------------------
-- Permission matrix
-- -----------------------------------------------------------------------------

-- Admin holds every permission in the catalogue. Generated from the same list the
-- seed-sync test checks, so a newly added permission cannot be forgotten.
insert into public.role_permissions (role_id, permission)
select 'role_admin', p
from unnest(array[
  'user:create', 'user:update', 'user:delete', 'user:list',
  'academic_year:manage', 'class:manage', 'section:manage', 'subject:manage',
  'exam:manage', 'assignment:manage',
  'student:create', 'student:update', 'student:delete', 'student:view',
  'student:import', 'student:export',
  'marks:view_assigned', 'marks:view_all', 'marks:edit', 'marks:correct_locked',
  'marks:submit', 'marks:review', 'marks:approve', 'marks:reject', 'marks:lock',
  'grading:manage', 'grading:view',
  'ocr:upload', 'ocr:review', 'ocr:confirm', 'ocr:view_assigned', 'ocr:view_all',
  'report:view_assigned', 'report:view_all', 'export:create',
  'audit_log:view', 'settings:manage', 'notification:view',
  'import:manage'
]) as p
on conflict do nothing;

-- Teacher: own profile only, assigned classes only.
insert into public.role_permissions (role_id, permission)
select 'role_teacher', p
from unnest(array[
  'user:update',            -- own profile only — RLS policy scopes this to id = self
  'student:view',
  'marks:view_assigned',
  'marks:edit',
  'marks:submit',
  'ocr:upload',
  'ocr:review',
  'ocr:confirm',
  'ocr:view_assigned',
  'report:view_assigned',
  'export:create',
  'grading:view',
  'notification:view',
  'student:export'
]) as p
on conflict do nothing;

-- Reviewer / principal: reads and adjudicates everything, configures grading.
insert into public.role_permissions (role_id, permission)
select 'role_reviewer', p
from unnest(array[
  'user:list',
  'student:view',
  'student:export',
  'marks:view_all',
  'marks:review',
  'marks:approve',
  'marks:reject',
  'marks:lock',
  'marks:correct_locked',
  'report:view_all',
  'export:create',
  'grading:view',
  'grading:manage',
  'notification:view',
  'ocr:view_all',
  'student:import'
]) as p
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Default grading scheme: percentage bands. Fully editable by admins.
-- -----------------------------------------------------------------------------
insert into public.grading_schemes (id, name, description, is_default)
values (gen_random_uuid(), 'Standard Percentage',
        'Default 0-100 percentage grading bands', true)
on conflict (name) do nothing;

insert into public.grading_rules
  (scheme_id, grade, min_percentage, max_percentage, grade_point, is_pass, sort_order)
select s.id, g.grade, g.min_pct, g.max_pct, g.points, g.is_pass, g.sort_order
from public.grading_schemes s
cross join (values
  ('A+', 90.00, 100.00, 5.00, true,  1),
  ('A',  80.00,  90.00, 4.50, true,  2),
  ('B+', 70.00,  80.00, 4.00, true,  3),
  ('B',  60.00,  70.00, 3.50, true,  4),
  ('C',  50.00,  60.00, 3.00, true,  5),
  ('D',  40.00,  50.00, 2.00, true,  6),
  ('F',   0.00,  40.00, 0.00, false, 7)
) as g(grade, min_pct, max_pct, points, is_pass, sort_order)
where s.name = 'Standard Percentage'
on conflict (scheme_id, grade) do nothing;

-- -----------------------------------------------------------------------------
-- Application settings
-- -----------------------------------------------------------------------------
insert into public.settings (key, value) values
  ('school.name',                 'Demo School'),
  ('school.academic_year',        '2026-2027'),
  ('marks.lock_requires_reason',  'true'),
  ('import.max_rows',             '5000'),
  ('report.sync_row_limit',       '2000'),
  ('notifications.email_enabled', 'false')
on conflict (key) do update set value = excluded.value;

-- Point `active_grading_scheme_id` at whatever ended up default, since the
-- scheme id is generated rather than fixed.
insert into public.settings (key, value)
select 'active_grading_scheme_id',
       (select id::text from public.grading_schemes where is_default limit 1)
where exists (select 1 from public.grading_schemes where is_default)
on conflict (key) do update set value = excluded.value;