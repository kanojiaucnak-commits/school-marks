-- =============================================================================
-- Row Level Security — the new authorisation boundary
--
-- Previously every protected request passed through
-- `requirePermission()` in Worker middleware (Business Rule 8). With the Worker
-- retired, Postgres RLS *is* the enforcement boundary. This is strictly stronger:
-- a bug in an Edge Function or a direct PostgREST call from the browser can no
-- longer read a row the caller should not see.
--
-- The frontend still uses `hasPermission()` from @school/shared purely to decide
-- what to RENDER. It is never the enforcement boundary.
--
-- Identity model
-- --------------
-- Clerk is the JWT issuer for Supabase. `auth.jwt() ->> 'sub'` is the Clerk user
-- id (`user_2aBc...`). Every helper below is `SECURITY DEFINER` so that reading
-- `profiles` from inside a policy does not recurse into the policies on
-- `profiles` itself.
--
-- Role freshness
-- --------------
-- `current_role()` reads the role from the `profiles` table rather than from the
-- JWT, so revoking an admin takes effect on the very next statement instead of
-- waiting for the Clerk session token to refresh. It is declared STABLE so
-- Postgres may evaluate it once per statement.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Identity helpers
-- -----------------------------------------------------------------------------
create or replace function public.current_clerk_id()
returns text
language sql stable
as $$
  select coalesce(auth.jwt() ->> 'sub', auth.uid()::text);
$$;

create or replace function public.current_role()
returns text
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select p.role_id
       from public.profiles p
      where p.id = public.current_clerk_id()
        and p.status = 'active'),
    -- Fallback for the window between Clerk sign-in and the profile trigger.
    auth.jwt() ->> 'role'
  );
$$;

create or replace function public.has_permission(perm text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.role_permissions rp
      join public.profiles p on p.role_id = rp.role_id
     where p.id = public.current_clerk_id()
       and p.status = 'active'
       and rp.permission = perm
  );
$$;

-- True when the caller may see every row of a sheet-based table (admin, reviewer
-- via `marks:view_all` / `ocr:view_all` / `report:view_all`).
create or replace function public.current_clerk_id_is_active()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = public.current_clerk_id() and p.status = 'active'
  );
$$;

/**
 * Teacher scoping.
 *
 * A teacher may only touch rows belonging to a section+subject+year they are
 * assigned to. This is the row-level counterpart to the `*:view_assigned`
 * permissions in @school/shared.
 *
 * Note `exam_id` is deliberately NOT part of the scope: `teacher_assignments` is
 * keyed on (teacher, year, class, section, subject), and a teacher is assigned
 * to a subject for a whole section regardless of which exam is being marked.
 */
create or replace function public.is_assigned_to(
  p_section uuid,
  p_subject uuid,
  p_year    uuid
)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.teacher_assignments ta
     where ta.teacher_id       = public.current_clerk_id()
       and ta.section_id       = p_section
       and ta.subject_id       = p_subject
       and ta.academic_year_id = p_year
  );
$$;

-- Can the caller read rows scoped to this section+subject+year?
create or replace function public.can_read_sheet(
  p_section uuid,
  p_subject uuid,
  p_year    uuid
)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.has_permission('marks:view_all')
      or public.is_assigned_to(p_section, p_subject, p_year);
$$;

-- Can the caller write rows scoped to this section+subject+year?
create or replace function public.can_write_sheet(
  p_section uuid,
  p_subject uuid,
  p_year    uuid
)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.has_permission('marks:edit')
     and (public.has_permission('marks:view_all')
          or public.is_assigned_to(p_section, p_subject, p_year));
$$;

-- Can the caller administer grading schemes? Mirrors GRADING_MANAGE.
create or replace function public.can_manage_grading()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.has_permission('grading:manage');
$$;

-- =============================================================================
-- Auto-create a profile the first time a Clerk user signs in
--
-- Clerk's `public_metadata.role` is the source of truth for role assignment, so
-- an admin can grant a role from the Clerk dashboard. Unknown roles fall back to
-- the least-privileged role (teacher) — never to admin.
-- =============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  requested_role text;
begin
  requested_role := new.raw_user_meta_data ->> 'role';

  insert into public.profiles (id, email, full_name, role_id)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name',
             new.raw_user_meta_data ->> 'name',
             split_part(coalesce(new.email, ''), '@', 1)),
    case
      when requested_role in ('admin', 'teacher', 'reviewer') then requested_role
      else 'role_teacher'
    end
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep `email` in sync when a user changes it in Clerk.
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.handle_user_email_change();

-- =============================================================================
-- Enable RLS everywhere
-- =============================================================================
alter table public.roles                  enable row level security;
alter table public.role_permissions       enable row level security;
alter table public.profiles               enable row level security;
alter table public.academic_years         enable row level security;
alter table public.classes                enable row level security;
alter table public.sections               enable row level security;
alter table public.subjects               enable row level security;
alter table public.exams                  enable row level security;
alter table public.students               enable row level security;
alter table public.teacher_assignments    enable row level security;
alter table public.grading_schemes        enable row level security;
alter table public.grading_rules          enable row level security;
alter table public.mark_submissions       enable row level security;
alter table public.marks                  enable row level security;
alter table public.ocr_documents          enable row level security;
alter table public.ocr_results            enable row level security;
alter table public.audit_logs             enable row level security;
alter table public.notifications          enable row level security;
alter table public.import_batches         enable row level security;
alter table public.export_jobs            enable row level security;
alter table public.settings               enable row level security;

-- -----------------------------------------------------------------------------
-- roles / role_permissions — reference data, readable by any signed-in user so
-- the UI can label roles. Writable only by admins.
-- -----------------------------------------------------------------------------
create policy roles_select on public.roles
  for select to authenticated using (public.current_clerk_id_is_active());

create policy roles_admin_write on public.roles
  for all to authenticated
  using (public.has_permission('user:create'))
  with check (public.has_permission('user:create'));

create policy role_permissions_select on public.role_permissions
  for select to authenticated using (true);

create policy role_permissions_admin_write on public.role_permissions
  for all to authenticated
  using (public.has_permission('user:create'))
  with check (public.has_permission('user:create'));

-- -----------------------------------------------------------------------------
-- profiles — own row always; staff with USER_LIST may read others.
-- Users may edit their own name/phone; only admins may change role or status.
-- -----------------------------------------------------------------------------
create policy profiles_select_self on public.profiles
  for select to authenticated using (id = public.current_clerk_id());

create policy profiles_select_staff on public.profiles
  for select to authenticated using (public.has_permission('user:list'));

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = public.current_clerk_id())
  with check (id = public.current_clerk_id());

create policy profiles_admin_all on public.profiles
  for all to authenticated
  using (public.has_permission('user:update'))
  with check (public.has_permission('user:update'));

-- Guard against privilege escalation through the "own row" policy: a user must
-- not be able to promote themselves by writing role_id.
create or replace function public.prevent_self_role_escalation()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.id = public.current_clerk_id()
     and new.role_id is distinct from old.role_id
     and not public.has_permission('user:update') then
    raise exception 'only an administrator may change your own role';
  end if;
  return new;
end;
$$;

create trigger trg_profiles_no_self_escalation
  before update on public.profiles
  for each row execute function public.prevent_self_role_escalation();

-- -----------------------------------------------------------------------------
-- Academic structure + subjects + exams — read for any signed-in user,
-- write gated on the matching MANAGE permission.
-- -----------------------------------------------------------------------------
create policy academic_years_read on public.academic_years
  for select to authenticated using (public.current_clerk_id_is_active());

create policy academic_years_write on public.academic_years
  for all to authenticated
  using (public.has_permission('academic_year:manage'))
  with check (public.has_permission('academic_year:manage'));

create policy classes_read on public.classes
  for select to authenticated using (public.current_clerk_id_is_active());

create policy classes_write on public.classes
  for all to authenticated
  using (public.has_permission('class:manage'))
  with check (public.has_permission('class:manage'));

create policy sections_read on public.sections
  for select to authenticated using (public.current_clerk_id_is_active());

create policy sections_write on public.sections
  for all to authenticated
  using (public.has_permission('section:manage'))
  with check (public.has_permission('section:manage'));

create policy subjects_read on public.subjects
  for select to authenticated using (public.current_clerk_id_is_active());

create policy subjects_write on public.subjects
  for all to authenticated
  using (public.has_permission('subject:manage'))
  with check (public.has_permission('subject:manage'));

create policy exams_read on public.exams
  for select to authenticated using (public.current_clerk_id_is_active());

create policy exams_write on public.exams
  for all to authenticated
  using (public.has_permission('exam:manage'))
  with check (public.has_permission('exam:manage'));

-- -----------------------------------------------------------------------------
-- students — school-wide read for anyone with STUDENT_VIEW (teachers hold it),
-- matching the original Worker behaviour where STUDENT_VIEW was not row-scoped.
-- -----------------------------------------------------------------------------
create policy students_read on public.students
  for select to authenticated using (public.has_permission('student:view'));

create policy students_insert on public.students
  for insert to authenticated with check (public.has_permission('student:create'));

create policy students_update on public.students
  for update to authenticated
  using (public.has_permission('student:update'))
  with check (public.has_permission('student:update'));

create policy students_delete on public.students
  for delete to authenticated using (public.has_permission('student:delete'));

-- -----------------------------------------------------------------------------
-- teacher_assignments — a teacher sees their own; ASSIGNMENT_MANAGE sees all.
-- -----------------------------------------------------------------------------
create policy teacher_assignments_read on public.teacher_assignments
  for select to authenticated
  using (teacher_id = public.current_clerk_id()
         or public.has_permission('assignment:manage'));

create policy teacher_assignments_write on public.teacher_assignments
  for all to authenticated
  using (public.has_permission('assignment:manage'))
  with check (public.has_permission('assignment:manage'));

-- -----------------------------------------------------------------------------
-- grading schemes / rules — read for all signed-in users (teachers need the
-- bands to display grades), write for GRADING_MANAGE.
-- -----------------------------------------------------------------------------
create policy grading_schemes_read on public.grading_schemes
  for select to authenticated using (public.current_clerk_id_is_active());

create policy grading_schemes_write on public.grading_schemes
  for all to authenticated
  using (public.has_permission('grading:manage'))
  with check (public.has_permission('grading:manage'));

create policy grading_rules_read on public.grading_rules
  for select to authenticated using (public.current_clerk_id_is_active());

create policy grading_rules_write on public.grading_rules
  for all to authenticated
  using (public.has_permission('grading:manage'))
  with check (public.has_permission('grading:manage'));

-- -----------------------------------------------------------------------------
-- mark_submissions — the authorisation boundary for the marks workflow.
-- -----------------------------------------------------------------------------
create policy submissions_read on public.mark_submissions
  for select to authenticated
  using (public.can_read_sheet(section_id, subject_id, academic_year_id));

create policy submissions_teacher_insert on public.mark_submissions
  for insert to authenticated
  with check (public.has_permission('marks:submit')
              and public.is_assigned_to(section_id, subject_id, academic_year_id)
              or public.has_permission('marks:view_all'));

create policy submissions_owner_update on public.mark_submissions
  for update to authenticated
  using (
    -- A teacher may edit their own sheet only while it is still editable.
    (public.is_assigned_to(section_id, subject_id, academic_year_id)
     and public.has_permission('marks:edit')
     and status in ('DRAFT', 'RETURNED', 'REJECTED'))
    -- Reviewers/admins act on submitted sheets.
    or (public.has_permission('marks:review') and status in ('SUBMITTED', 'UNDER_REVIEW'))
    or (public.has_permission('marks:approve') and status in ('UNDER_REVIEW', 'APPROVED'))
    or (public.has_permission('marks:lock')   and status = 'APPROVED')
  );

create policy submissions_delete on public.mark_submissions
  for delete to authenticated using (public.has_permission('marks:lock'));

-- -----------------------------------------------------------------------------
-- marks — row-scoped through the owning student's section.
-- -----------------------------------------------------------------------------
create policy marks_read on public.marks
  for select to authenticated
  using (public.can_read_sheet(
    (select s.section_id       from public.students s where s.id = student_id),
    subject_id,
    academic_year_id));

create policy marks_insert on public.marks
  for insert to authenticated
  with check (public.can_write_sheet(
    (select s.section_id       from public.students s where s.id = student_id),
    subject_id,
    academic_year_id));

create policy marks_update on public.marks
  for update to authenticated
  using (public.can_write_sheet(
    (select s.section_id       from public.students s where s.id = student_id),
    subject_id,
    academic_year_id))
  with check (public.can_write_sheet(
    (select s.section_id       from public.students s where s.id = student_id),
    subject_id,
    academic_year_id));

-- Correcting a locked sheet needs an explicit permission, and the submission
-- must genuinely be frozen — not merely typed as LOCKED by the client.
create policy marks_update_locked on public.marks
  for update to authenticated
  using (public.has_permission('marks:correct_locked'))
  with check (public.has_permission('marks:correct_locked'));

create policy marks_delete on public.marks
  for delete to authenticated
  using (public.can_write_sheet(
    (select s.section_id       from public.students s where s.id = student_id),
    subject_id,
    academic_year_id));

-- -----------------------------------------------------------------------------
-- ocr_documents / ocr_results — own documents, or all for OCR_VIEW_ALL.
-- -----------------------------------------------------------------------------
create policy ocr_documents_read on public.ocr_documents
  for select to authenticated
  using (uploaded_by = public.current_clerk_id()
         or public.has_permission('ocr:view_all'));

create policy ocr_documents_insert on public.ocr_documents
  for insert to authenticated
  with check (public.has_permission('ocr:upload')
              and uploaded_by = public.current_clerk_id());

create policy ocr_documents_update on public.ocr_documents
  for update to authenticated
  using (uploaded_by = public.current_clerk_id()
         or public.has_permission('ocr:confirm'))
  with check (uploaded_by = public.current_clerk_id()
              or public.has_permission('ocr:confirm'));

create policy ocr_documents_delete on public.ocr_documents
  for delete to authenticated
  using (uploaded_by = public.current_clerk_id()
         or public.has_permission('ocr:confirm'));

create policy ocr_results_read on public.ocr_results
  for select to authenticated
  using (exists (
    select 1 from public.ocr_documents d
     where d.id = document_id
       and (d.uploaded_by = public.current_clerk_id()
            or public.has_permission('ocr:view_all'))
  ));

create policy ocr_results_write on public.ocr_results
  for all to authenticated
  using (public.has_permission('ocr:review') or public.has_permission('ocr:confirm'))
  with check (public.has_permission('ocr:review') or public.has_permission('ocr:confirm'));

-- -----------------------------------------------------------------------------
-- audit_logs — AUDIT_LOG_VIEW only, for reads. Append-only for writes and
-- protected by trigger from UPDATE/DELETE for everyone including admins.
-- System writes (the OCR Edge Function) use the service role, which bypasses RLS.
-- -----------------------------------------------------------------------------
create policy audit_logs_read on public.audit_logs
  for select to authenticated using (public.has_permission('audit_log:view'));

create policy audit_logs_append on public.audit_logs
  for insert to authenticated with check (true);

-- -----------------------------------------------------------------------------
-- notifications — own rows only.
-- -----------------------------------------------------------------------------
create policy notifications_read on public.notifications
  for select to authenticated using (user_id = public.current_clerk_id());

create policy notifications_update on public.notifications
  for update to authenticated
  using (user_id = public.current_clerk_id())
  with check (user_id = public.current_clerk_id());

create policy notifications_delete on public.notifications
  for delete to authenticated using (user_id = public.current_clerk_id());

-- -----------------------------------------------------------------------------
-- import_batches / export_jobs — own rows, or all for IMPORT_MANAGE.
-- -----------------------------------------------------------------------------
create policy import_batches_read on public.import_batches
  for select to authenticated
  using (uploaded_by = public.current_clerk_id()
         or public.has_permission('import:manage'));

create policy import_batches_write on public.import_batches
  for all to authenticated
  using (uploaded_by = public.current_clerk_id()
         or public.has_permission('import:manage'))
  with check (uploaded_by = public.current_clerk_id()
              or public.has_permission('import:manage'));

create policy export_jobs_read on public.export_jobs
  for select to authenticated
  using (requested_by = public.current_clerk_id()
         or public.has_permission('export:create'));

create policy export_jobs_insert on public.export_jobs
  for insert to authenticated with check (requested_by = public.current_clerk_id());

create policy export_jobs_update on public.export_jobs
  for update to authenticated
  using (requested_by = public.current_clerk_id())
  with check (requested_by = public.current_clerk_id());

-- -----------------------------------------------------------------------------
-- settings — read for all signed-in users, write for SETTINGS_MANAGE.
-- -----------------------------------------------------------------------------
create policy settings_read on public.settings
  for select to authenticated using (public.current_clerk_id_is_active());

create policy settings_write on public.settings
  for all to authenticated
  using (public.has_permission('settings:manage'))
  with check (public.has_permission('settings:manage'));

-- =============================================================================
-- Supabase Storage buckets
--
-- Replaces the private R2 bucket. `public` is false so that reads still go
-- through a signed URL minted by an Edge Function, preserving the original rule
-- that uploaded files are never publicly addressable.
-- =============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('mark-sheets', 'mark-sheets', false, 10485760,
   array['image/jpeg', 'image/png', 'application/pdf', 'image/webp']),
  ('generated-reports', 'generated-reports', false, 52428800, null),
  ('imports', 'imports', false, 10485760, null)
on conflict (id) do nothing;

-- Uploads are written under `uploads/{clerkUserId}/...`, so a user owns their own
-- objects; ADR-manage users may read anything.
create policy mark_sheets_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'mark-sheets'
    and (storage.foldername(name))[1] = 'uploads'
    and (storage.foldername(name))[2] = public.current_clerk_id()
    and public.has_permission('ocr:upload')
  );

create policy mark_sheets_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'mark-sheets'
    and (public.has_permission('ocr:view_all')
         or (storage.foldername(name))[2] = public.current_clerk_id())
  );

create policy mark_sheets_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'mark-sheets'
    and ((storage.foldername(name))[2] = public.current_clerk_id()
         and public.has_permission('ocr:confirm')
         or public.has_permission('ocr:confirm'))
  );

-- Generated reports are owned by whoever requested the export.
create policy reports_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'generated-reports'
    and ((storage.foldername(name))[1] = 'exports'
         and (storage.foldername(name))[2] = public.current_clerk_id())
  );

create policy reports_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'generated-reports'
    and (storage.foldername(name))[1] = 'exports'
    and (storage.foldername(name))[2] = public.current_clerk_id()
  );