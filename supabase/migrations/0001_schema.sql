-- =============================================================================
-- School Marks Management System — Supabase/Postgres schema
--
-- Ported from the Cloudflare D1 (SQLite) schema in the retired
-- `worker/migrations/0001_initial.sql`.
--
-- Differences from the D1 original, and why:
--
--   1. IDs are `uuid` with `gen_random_uuid()` defaults. The D1 version had the
--      Worker mint opaque text ids; Postgres gives us real native uuid columns,
--      which supabase-js round-trips without any client-side id generation.
--
--   2. `users` becomes `profiles`, keyed by the *Clerk user id* (text, e.g.
--      `user_2aBc...`), not a uuid. Clerk owns identity now: passwords, sessions,
--      password-reset tokens, email verification and account lockout all live in
--      Clerk. `profiles` keeps only the school-specific facts the Worker used to
--      own: role, display name, employee code, phone and active/inactive status.
--
--   3. The `sessions`, `password_reset_tokens` and `login_attempts` tables are
--      GONE. Clerk owns session lifecycle and brute-force protection. See
--      0002_rls.sql for the authorisation model that replaces them.
--
--   4. Boolean columns are real `boolean`, not `INTEGER CHECK (x IN (0,1))`.
--      Every `*_id TEXT` becomes `uuid`. Every ISO-8601 string timestamp becomes
--      `timestamptz`. Marks/percentages become `numeric(6,2)` so they are exact
--      decimals rather than binary floats.
--
--   5. `updated_at` is now maintained by a trigger rather than by application
--      code, because rows are written from many places (direct client writes via
--      PostgREST, Edge Functions, imports) and it is easy to forget.
--
-- Every CHECK constraint below still mirrors a Zod enum in @school/shared. The
-- database remains the final backstop for domain invariants.
-- =============================================================================

create extension if not exists pgcrypto;
-- Case-insensitive email/username uniqueness. The D1 schema used
-- `COLLATE NOCASE`; `citext` is the Postgres equivalent and keeps the
-- `findUserByIdentifier`-style lookups from becoming case-sensitive surprises.
create extension if not exists citext;

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- =============================================================================
-- Roles — the data-driven permission catalogue
--
-- This table was previously "informational only" (enforcement lived in Worker
-- middleware). It is now the *actual* enforcement source read by
-- `has_permission()` in RLS policies, so that the "nothing is hard-coded"
-- promise of the original design survives the move to Postgres.
-- =============================================================================
create table public.roles (
  id          text primary key,
  name        text not null unique,
  description text,
  created_at  timestamptz not null default now()
);

comment on table public.roles is
  'Role catalogue. Kept data-driven so the RLS layer reads permissions from here rather than hard-coding them.';

-- =============================================================================
-- Role permissions — normalised so a permission can be granted to many roles
-- =============================================================================
create table public.role_permissions (
  role_id    text not null references public.roles(id) on delete cascade,
  permission text not null,
  primary key (role_id, permission)
);

create index idx_role_permissions_permission on public.role_permissions (permission);

-- =============================================================================
-- Profiles — school-specific facts about a Clerk user
--
-- `id` is the Clerk user id. Rows are created lazily on first sign-in by the
-- `handle_new_user()` trigger in 0002_rls.sql, which also copies the role out of
-- the Clerk user's `public_metadata` so admins can grant roles from the Clerk
-- dashboard.
-- =============================================================================
create table public.profiles (
  id            text primary key,             -- Clerk user id
  email         citext not null unique,
  full_name     text not null,
  username      citext unique,
  role_id       text not null default 'role_teacher' references public.roles(id) on delete restrict,
  phone         text,
  employee_code citext unique,
  status        text not null default 'active'
                  check (status in ('active', 'inactive')),
  last_login_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index idx_profiles_role     on public.profiles (role_id);
create index idx_profiles_status   on public.profiles (status);
create index idx_profiles_fullname on public.profiles (full_name);
create index idx_profiles_employee on public.profiles (employee_code);

create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- =============================================================================
-- Academic structure: Academic Year -> Class -> Section
-- =============================================================================
create table public.academic_years (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,             -- "2026-2027"
  start_date date not null,
  end_date   date not null,
  is_current boolean not null default false,
  status     text not null default 'active'
               check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chk_academic_year_range check (end_date > start_date)
);

-- At most one academic year may be flagged current.
create unique index idx_academic_years_single_current
  on public.academic_years (is_current) where is_current;

create trigger trg_academic_years_updated_at
  before update on public.academic_years
  for each row execute function public.set_updated_at();

create table public.classes (
  id               uuid primary key default gen_random_uuid(),
  academic_year_id uuid not null references public.academic_years(id) on delete restrict,
  name             text not null,              -- "10"
  level            integer,                    -- numeric grade for sorting/reporting
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (academic_year_id, name)
);

create index idx_classes_year on public.classes (academic_year_id);

create trigger trg_classes_updated_at
  before update on public.classes
  for each row execute function public.set_updated_at();

create table public.sections (
  id         uuid primary key default gen_random_uuid(),
  class_id   uuid not null references public.classes(id) on delete cascade,
  name       text not null,                    -- "A"
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (class_id, name)
);

create index idx_sections_class on public.sections (class_id);

create trigger trg_sections_updated_at
  before update on public.sections
  for each row execute function public.set_updated_at();

-- =============================================================================
-- Subjects
-- =============================================================================
create table public.subjects (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,            -- "MATH"
  name        text not null,
  description text,
  is_elective boolean not null default false,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_subjects_name on public.subjects (name);

create trigger trg_subjects_updated_at
  before update on public.subjects
  for each row execute function public.set_updated_at();

-- =============================================================================
-- Exams — `max_marks` is the ceiling every mark row is validated against
-- =============================================================================
create table public.exams (
  id               uuid primary key default gen_random_uuid(),
  academic_year_id uuid not null references public.academic_years(id) on delete restrict,
  name             text not null,              -- "Term 1"
  max_marks        numeric(6,2) not null check (max_marks > 0),
  weightage        numeric(6,2) not null default 1 check (weightage > 0),
  exam_date        date,
  status           text not null default 'scheduled'
                     check (status in ('scheduled', 'ongoing', 'completed', 'cancelled')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (academic_year_id, name)
);

create index idx_exams_year on public.exams (academic_year_id);

create trigger trg_exams_updated_at
  before update on public.exams
  for each row execute function public.set_updated_at();

-- =============================================================================
-- Students
--
-- A student row is scoped to ONE academic year. Promotion leaves the old row
-- untouched and inserts a new row for the next year, which is what keeps
-- historical year-on-year records intact.
-- =============================================================================
create table public.students (
  id               uuid primary key default gen_random_uuid(),
  -- Unique *per academic year*, not globally.
  student_number   text not null,
  admission_number text unique,
  roll_number      integer check (roll_number is null or roll_number >= 0),
  full_name        text not null,
  normalized_name  text not null,              -- precomputed for fast OCR/search
  date_of_birth    date,
  gender           text check (gender is null or gender in ('male', 'female', 'other')),
  class_id         uuid not null references public.classes(id) on delete restrict,
  section_id       uuid not null references public.sections(id) on delete restrict,
  academic_year_id uuid not null references public.academic_years(id) on delete restrict,
  guardian_name    text,
  guardian_phone   text,
  guardian_email   text,
  address          text,
  status           text not null default 'active'
                     check (status in ('active', 'inactive', 'graduated', 'transferred')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (academic_year_id, student_number),
  constraint chk_student_dob_not_future check (date_of_birth is null or date_of_birth <= current_date)
);

-- Roll numbers are unique per section per year.
create unique index idx_students_section_roll
  on public.students (section_id, academic_year_id, roll_number)
  where roll_number is not null;

create index idx_students_class     on public.students (class_id, section_id);
create index idx_students_year      on public.students (academic_year_id);
create index idx_students_status    on public.students (status);
create index idx_students_name      on public.students (full_name);
create index idx_students_norm_name on public.students (normalized_name);
create index idx_students_number    on public.students (student_number);
create index idx_students_roll      on public.students (roll_number);

create trigger trg_students_updated_at
  before update on public.students
  for each row execute function public.set_updated_at();

-- =============================================================================
-- Teacher assignments — the row-level authorisation boundary for teachers
--
-- This is the table that makes `marks:view_assigned` and friends a *row* check
-- rather than a role check. See `is_assigned_teacher()` in 0002_rls.sql.
-- =============================================================================
create table public.teacher_assignments (
  id               uuid primary key default gen_random_uuid(),
  teacher_id       text not null references public.profiles(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  class_id         uuid not null references public.classes(id) on delete cascade,
  section_id       uuid not null references public.sections(id) on delete cascade,
  subject_id       uuid not null references public.subjects(id) on delete cascade,
  created_at       timestamptz not null default now(),
  unique (teacher_id, academic_year_id, class_id, section_id, subject_id)
);

create index idx_assignments_teacher  on public.teacher_assignments (teacher_id, academic_year_id);
create index idx_assignments_lookup   on public.teacher_assignments (section_id, subject_id, academic_year_id);
create index idx_assignments_subject  on public.teacher_assignments (subject_id);

-- =============================================================================
-- Grading schemes — nothing about grades is hard-coded
-- =============================================================================
create table public.grading_schemes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  description text,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index idx_grading_single_default
  on public.grading_schemes (is_default) where is_default;

create trigger trg_grading_schemes_updated_at
  before update on public.grading_schemes
  for each row execute function public.set_updated_at();

create table public.grading_rules (
  id             uuid primary key default gen_random_uuid(),
  scheme_id      uuid not null references public.grading_schemes(id) on delete cascade,
  grade          text not null,
  min_percentage numeric(5,2) not null check (min_percentage >= 0 and min_percentage <= 100),
  max_percentage numeric(5,2) not null check (max_percentage >= 0 and max_percentage <= 100),
  grade_point    numeric(4,2) check (grade_point is null or grade_point >= 0),
  is_pass        boolean not null default true,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  unique (scheme_id, grade)
);

create index idx_grading_rules_scheme on public.grading_rules (scheme_id, min_percentage);

-- =============================================================================
-- Mark submissions — one "sheet" per class/section/subject/exam/year.
-- The workflow state machine is enforced by `can_submit_marks`-style helpers in
-- 0002_rls.sql, not by the client.
-- =============================================================================
create table public.mark_submissions (
  id               uuid primary key default gen_random_uuid(),
  academic_year_id uuid not null references public.academic_years(id) on delete restrict,
  class_id         uuid not null references public.classes(id) on delete restrict,
  section_id       uuid not null references public.sections(id) on delete restrict,
  subject_id       uuid not null references public.subjects(id) on delete restrict,
  exam_id          uuid not null references public.exams(id) on delete restrict,
  teacher_id       text not null references public.profiles(id) on delete restrict,
  status           text not null default 'DRAFT'
                     check (status in ('DRAFT','SUBMITTED','UNDER_REVIEW','APPROVED','LOCKED','RETURNED','REJECTED')),
  total_students   integer not null default 0 check (total_students >= 0),
  entered_count    integer not null default 0 check (entered_count >= 0),
  average_marks    numeric(6,2),
  submitted_at     timestamptz,
  approved_at      timestamptz,
  locked_at        timestamptz,
  reviewed_by      text references public.profiles(id) on delete set null,
  review_comments  text,
  version          integer not null default 1 check (version >= 1),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (academic_year_id, class_id, section_id, subject_id, exam_id)
);

create index idx_submissions_teacher on public.mark_submissions (teacher_id, status);
create index idx_submissions_status  on public.mark_submissions (status);
create index idx_submissions_section on public.mark_submissions (section_id, subject_id, exam_id);
create index idx_submissions_year    on public.mark_submissions (academic_year_id);
create index idx_submissions_review  on public.mark_submissions (status, submitted_at);

create trigger trg_mark_submissions_updated_at
  before update on public.mark_submissions
  for each row execute function public.set_updated_at();

-- =============================================================================
-- OCR documents — metadata only; bytes live in Supabase Storage
--
-- `r2_key` becomes `storage_bucket` + `storage_path`. Paths are still generated
-- server-side, never derived from a user-supplied filename.
-- =============================================================================
create table public.ocr_documents (
  id                 uuid primary key default gen_random_uuid(),
  uploaded_by        text not null references public.profiles(id) on delete restrict,
  academic_year_id   uuid not null references public.academic_years(id) on delete restrict,
  class_id           uuid not null references public.classes(id) on delete restrict,
  section_id         uuid not null references public.sections(id) on delete restrict,
  subject_id         uuid not null references public.subjects(id) on delete restrict,
  exam_id            uuid not null references public.exams(id) on delete restrict,
  storage_bucket     text not null default 'mark-sheets',
  storage_path       text not null unique,      -- generated key, never user filename
  original_filename  text not null,
  content_type       text not null,
  size_bytes         bigint not null check (size_bytes > 0),
  page_count         integer,
  provider           text not null,
  status             text not null default 'UPLOADED'
                       check (status in ('UPLOADED','QUEUED','PROCESSING','COMPLETED','FAILED','CONFIRMED','CANCELLED')),
  error_message      text,
  overall_confidence numeric(4,3),
  confirmed_marks_count integer not null default 0,
  started_at         timestamptz,
  completed_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index idx_ocr_owner  on public.ocr_documents (uploaded_by, status);
create index idx_ocr_scope  on public.ocr_documents (section_id, subject_id, exam_id);
create index idx_ocr_status on public.ocr_documents (status, created_at);

create trigger trg_ocr_documents_updated_at
  before update on public.ocr_documents
  for each row execute function public.set_updated_at();

-- =============================================================================
-- OCR results — suggestions only. `marks` rows are written on confirm.
-- =============================================================================
create table public.ocr_results (
  id                 uuid primary key default gen_random_uuid(),
  document_id        uuid not null references public.ocr_documents(id) on delete cascade,
  line_index         integer not null,
  raw_text           text,
  detected_identifier text,
  detected_name      text,
  detected_marks     text,
  confidence         numeric(4,3) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  bbox_page          integer,
  bbox_x             numeric(8,3),
  bbox_y             numeric(8,3),
  bbox_width         numeric(8,3),
  bbox_height        numeric(8,3),
  matched_student_id uuid references public.students(id) on delete set null,
  match_method       text not null default 'none'
                       check (match_method in ('student_id','roll_number','normalized_name','fuzzy_name','manual','none')),
  match_confidence   numeric(4,3) check (match_confidence is null or (match_confidence >= 0 and match_confidence <= 1)),
  match_candidates   jsonb,                    -- array of ambiguous candidates
  corrected_marks    text,
  corrected_status   text
                       check (corrected_status is null or corrected_status in ('PRESENT','ABSENT','EXEMPTED','MEDICAL')),
  remarks            text,
  verified           boolean not null default false,
  reviewed_by        text references public.profiles(id) on delete set null,
  reviewed_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (document_id, line_index)
);

create index idx_ocr_results_doc     on public.ocr_results (document_id, line_index);
create index idx_ocr_results_student on public.ocr_results (matched_student_id);

create trigger trg_ocr_results_updated_at
  before update on public.ocr_results
  for each row execute function public.set_updated_at();

-- =============================================================================
-- Marks
--
-- The UNIQUE constraint is the authoritative implementation of "a mark is unique
-- for student + subject + exam + academic year".
-- =============================================================================
create table public.marks (
  id                    uuid primary key default gen_random_uuid(),
  student_id            uuid not null references public.students(id) on delete cascade,
  subject_id            uuid not null references public.subjects(id) on delete restrict,
  exam_id               uuid not null references public.exams(id) on delete restrict,
  academic_year_id      uuid not null references public.academic_years(id) on delete restrict,
  teacher_assignment_id uuid references public.teacher_assignments(id) on delete set null,
  entered_by            text not null references public.profiles(id) on delete restrict,
  max_marks             numeric(6,2) not null check (max_marks > 0),
  marks_obtained        numeric(6,2) check (marks_obtained is null or marks_obtained >= 0),
  status                text not null default 'PRESENT'
                          check (status in ('PRESENT','ABSENT','EXEMPTED','MEDICAL')),
  percentage            numeric(5,2) check (percentage is null or (percentage >= 0 and percentage <= 100)),
  grade                 text,
  grade_point           numeric(4,2),
  is_pass               boolean,
  remarks               text,
  source                text not null default 'manual'
                          check (source in ('manual','ocr','import')),
  ocr_document_id       uuid references public.ocr_documents(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- A mark can never exceed the exam maximum.
  constraint chk_marks_within_max check (marks_obtained is null or marks_obtained <= max_marks),

  -- Non-numeric statuses must not carry a numeric mark.
  constraint chk_marks_status_consistency check (
    (status = 'PRESENT' and marks_obtained is not null) or
    (status <> 'PRESENT' and marks_obtained is null)
  ),

  unique (student_id, subject_id, exam_id, academic_year_id)
);

create index idx_marks_student on public.marks (student_id);
create index idx_marks_exam    on public.marks (exam_id, subject_id, academic_year_id);
create index idx_marks_sheet   on public.marks (academic_year_id, subject_id, exam_id);
create index idx_marks_grade   on public.marks (grade);
create index idx_marks_ocr     on public.marks (ocr_document_id);

create trigger trg_marks_updated_at
  before update on public.marks
  for each row execute function public.set_updated_at();

-- =============================================================================
-- Audit log — append-only.
--
-- `user_id` is deliberately NOT a foreign key to profiles, for two reasons:
--   (1) background work (the OCR Edge Function) acts as `system`, which is not a
--       profile row, and an FK would make every automated audit write fail;
--   (2) an audit trail must outlive the account that produced it.
-- The triggers below make the table immutable at the database level.
-- =============================================================================
create table public.audit_logs (
  id         uuid primary key default gen_random_uuid(),
  user_id    text,
  user_email text,
  action     text not null,
  entity_type text not null,
  entity_id  text,
  old_value  jsonb,
  new_value  jsonb,
  reason     text,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index idx_audit_created on public.audit_logs (created_at);
create index idx_audit_user    on public.audit_logs (user_id, created_at);
create index idx_audit_entity  on public.audit_logs (entity_type, entity_id);
create index idx_audit_action  on public.audit_logs (action, created_at);

create or replace function public.deny_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_logs is append-only';
end;
$$;

create trigger trg_audit_logs_no_update
  before update on public.audit_logs
  for each row execute function public.deny_audit_mutation();

create trigger trg_audit_logs_no_delete
  before delete on public.audit_logs
  for each row execute function public.deny_audit_mutation();

-- =============================================================================
-- Notifications — keyed by Clerk user id
-- =============================================================================
create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    text not null references public.profiles(id) on delete cascade,
  type       text not null,
  title      text not null,
  body       text,
  link       text,
  data       jsonb,                           -- payload for future channels
  channel    text not null default 'in_app' check (channel in ('in_app','email')),
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index idx_notifications_user on public.notifications (user_id, read_at, created_at);

-- =============================================================================
-- Import batches — student CSV/XLSX import
-- =============================================================================
create table public.import_batches (
  id               uuid primary key default gen_random_uuid(),
  uploaded_by      text not null references public.profiles(id) on delete restrict,
  filename         text not null,
  storage_path     text,
  academic_year_id uuid references public.academic_years(id) on delete set null,
  status           text not null default 'PENDING'
                     check (status in ('PENDING','VALIDATED','IMPORTED','FAILED')),
  total_rows       integer not null default 0,
  valid_rows       integer not null default 0,
  error_rows       integer not null default 0,
  rows             jsonb,                    -- array of preview rows
  errors           jsonb,                    -- array of validation errors
  created_count    integer not null default 0,
  updated_count    integer not null default 0,
  skipped_count    integer not null default 0,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz
);

create index idx_imports_user on public.import_batches (uploaded_by, created_at);

-- =============================================================================
-- Export jobs — asynchronous report generation for large datasets
-- =============================================================================
create table public.export_jobs (
  id           uuid primary key default gen_random_uuid(),
  requested_by text not null references public.profiles(id) on delete cascade,
  kind         text not null,
  format       text not null check (format in ('csv','xlsx','pdf','json')),
  params       jsonb,
  status       text not null default 'QUEUED'
                 check (status in ('QUEUED','RUNNING','COMPLETED','FAILED')),
  storage_path text,
  size_bytes   bigint,
  error        text,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  completed_at timestamptz
);

create index idx_export_jobs_user  on public.export_jobs (requested_by, created_at);
create index idx_export_jobs_queue on public.export_jobs (status, created_at);

-- =============================================================================
-- Application settings (key/value)
-- =============================================================================
create table public.settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now(),
  updated_by text references public.profiles(id) on delete set null
);

-- =============================================================================
-- Convenience view: the marksheet row the UI renders
-- =============================================================================
create or replace view public.v_marksheet as
select
  m.*,
  s.full_name        as student_name,
  s.student_number,
  s.roll_number,
  sub.name           as subject_name,
  sub.code           as subject_code,
  e.name             as exam_name,
  e.max_marks        as exam_max_marks,
  c.name             as class_name,
  sec.name           as section_name,
  ay.name            as academic_year_name,
  ms.status          as submission_status,
  ms.id              as submission_id,
  ms.version         as submission_version
from public.marks m
join public.students s       on s.id = m.student_id
join public.subjects sub     on sub.id = m.subject_id
join public.exams e          on e.id = m.exam_id
join public.academic_years ay on ay.id = m.academic_year_id
join public.classes c        on c.id = s.class_id
join public.sections sec     on sec.id = s.section_id
left join public.mark_submissions ms
  on  ms.section_id       = s.section_id
  and ms.subject_id       = m.subject_id
  and ms.exam_id          = m.exam_id
  and ms.academic_year_id = m.academic_year_id;