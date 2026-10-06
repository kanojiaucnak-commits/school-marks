-- =============================================================================
-- Representative sample data
--
-- Runs on `supabase db reset`, not as a migration: this is sample content for looking
-- at the application, not schema, and recording it in the migration history would put
-- fake school data into every environment.
--
-- Everything here is idempotent, keyed on natural keys (subject code, class name,
-- exam name, student number), so `db reset` can be run repeatedly.
--
-- ── Why it exists ──────────────────────────────────────────────────────────────
--
-- With an empty database every page renders its empty state, so an entirely
-- untested application can look entirely healthy. None of the interesting behaviour
-- is reachable that way: the roster only fills in once sections and students exist,
-- the marks pages need exams and marks, and a teacher's scoping cannot be observed
-- until there is more than one teacher to scope against.
--
-- Names are invented. No real school's data is used.
-- =============================================================================

-- ── Academic year ───────────────────────────────────────────────────────────────
insert into public.academic_years (id, name, start_date, end_date, is_current, status)
values
  ('00000000-0000-0000-0000-000000000101', '2026-27', '2026-04-01', '2027-03-31', true, 'active')
on conflict (id) do nothing;

-- ── Classes ─────────────────────────────────────────────────────────────────────
-- `level` is an integer, not a label: it is the year number, not a band. The bands
-- that do exist live in `profiles.role_id` and in the grade columns of marks.
insert into public.classes (id, academic_year_id, name, level)
values
  ('00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000101', 'Grade 6',  6),
  ('00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000101', 'Grade 9',  9),
  ('00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-000000000101', 'Grade 12', 12)
on conflict (id) do nothing;

-- ── Sections ────────────────────────────────────────────────────────────────────
-- Two sections in Grade 9 and Grade 12 so that assignment scoping is observable: a
-- teacher assigned to 9-A must not see 9-B.
insert into public.sections (id, class_id, name)
values
  ('00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000201', 'A'),
  ('00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000201', 'B'),
  ('00000000-0000-0000-0000-000000000303', '00000000-0000-0000-0000-000000000202', 'A'),
  ('00000000-0000-0000-0000-000000000304', '00000000-0000-0000-0000-000000000202', 'B'),
  ('00000000-0000-0000-0000-000000000305', '00000000-0000-0000-0000-000000000203', 'A')
on conflict (id) do nothing;

-- ── Subjects ────────────────────────────────────────────────────────────────────
insert into public.subjects (id, code, name, description, is_elective, is_active)
values
  ('00000000-0000-0000-0000-000000000401', 'ENG', 'English',       'Language and literature',            false, true),
  ('00000000-0000-0000-0000-000000000402', 'MAT', 'Mathematics',   'Number, algebra and geometry',       false, true),
  ('00000000-0000-0000-0000-000000000403', 'SCI', 'Science',       'Physics, chemistry and biology',     false, true),
  ('00000000-0000-0000-0000-000000000404', 'SOC', 'Social Studies','History and geography',              false, true),
  ('00000000-0000-0000-0000-000000000405', 'ART', 'Art',           'Visual arts',                        true,  true),
  ('00000000-0000-0000-0000-000000000406', 'ICT', 'Information Technology', 'Computing',                  false, true)
on conflict (id) do nothing;

-- ── Students ───────────────────────────────────────────────────────────────────
-- `normalized_name` is NOT NULL with no trigger and no default, so it must be
-- supplied. It is derived here by `public.normalize_name()` rather than typed out,
-- because that function mirrors `normalizeName()` in `shared/src/utils.ts` and
-- `import-commit`'s own comment warns that a divergence means OCR matching silently
-- stops matching. Transcribing sixteen values by hand invites exactly that drift.
--
-- Deriving it means the VALUES list has to be fed through a SELECT: a VALUES list
-- cannot refer to a column from its own row.
--
-- Spread across sections deliberately — 9-A and 9-B have different students, which
-- is what makes a roster leak observable rather than theoretical.
insert into public.students
  (id, student_number, admission_number, roll_number, full_name, normalized_name,
   date_of_birth, gender, class_id, section_id, academic_year_id,
   guardian_name, guardian_phone, status)
-- The explicit casts are needed because a `VALUES` list of string literals is typed
-- `text`, and Postgres will not implicitly cast `text` to `uuid` or `date` on insert.
select
  v.id::uuid, v.student_number, v.admission_number, v.roll_number, v.full_name,
  public.normalize_name(v.full_name),
  v.date_of_birth::date, v.gender,
  v.class_id::uuid, v.section_id::uuid, v.academic_year_id::uuid,
  v.guardian_name, v.guardian_phone, v.status
from (values
  ('00000000-0000-0000-0000-000000000501', 'S2026001', 'ADM2026001', 1, 'Aarav Sharma',
   '2012-04-11', 'male',   '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000101', 'Ravi Sharma',   '+91-98100-00001', 'active'),
  ('00000000-0000-0000-0000-000000000502', 'S2026002', 'ADM2026002', 2, 'Diya Patel',
   '2012-07-02', 'female', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000101', 'Neha Patel',    '+91-98100-00002', 'active'),
  ('00000000-0000-0000-0000-000000000503', 'S2026003', 'ADM2026003', 3, 'Kabir Singh',
   '2011-11-23', 'male',   '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000101', 'Harjit Singh',  '+91-98100-00003', 'active'),
  ('00000000-0000-0000-0000-000000000504', 'S2026004', 'ADM2026004', 4, 'Meera Nair',
   '2012-01-30', 'female', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000101', 'Anil Nair',     '+91-98100-00004', 'active'),
  ('00000000-0000-0000-0000-000000000505', 'S2026005', 'ADM2026005', 5, 'Ishaan Rao',
   '2012-03-14', 'male',   '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000101', 'Sunil Rao',     '+91-98100-00005', 'active'),
  ('00000000-0000-0000-0000-000000000506', 'S2026006', 'ADM2026006', 6, 'Sara Khan',
   '2011-09-08', 'female', '00000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000101', 'Imran Khan',    '+91-98100-00006', 'active'),
  ('00000000-0000-0000-0000-000000000507', 'S2026007', 'ADM2026007', 1, 'Advait Joshi',
   '2010-05-19', 'male',   '00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000303', '00000000-0000-0000-0000-000000000101', 'Mohan Joshi',   '+91-98100-00007', 'active'),
  ('00000000-0000-0000-0000-000000000508', 'S2026008', 'ADM2026008', 2, 'Ananya Iyer',
   '2010-08-25', 'female', '00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000303', '00000000-0000-0000-0000-000000000101', 'Lakshmi Iyer',  '+91-98100-00008', 'active'),
  ('00000000-0000-0000-0000-000000000509', 'S2026009', 'ADM2026009', 3, 'Rohan Gupta',
   '2010-12-03', 'male',   '00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000303', '00000000-0000-0000-0000-000000000101', 'Suresh Gupta',  '+91-98100-00009', 'active'),
  ('00000000-0000-0000-0000-000000000510', 'S2026010', 'ADM2026010', 4, 'Priya Menon',
   '2010-06-17', 'female', '00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000304', '00000000-0000-0000-0000-000000000101', 'Kiran Menon',   '+91-98100-00010', 'active'),
  ('00000000-0000-0000-0000-000000000511', 'S2026011', 'ADM2026011', 5, 'Vihaan Malhotra',
   '2010-02-28', 'male',   '00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000304', '00000000-0000-0000-0000-000000000101', 'Asha Malhotra', '+91-98100-00011', 'active'),
  ('00000000-0000-0000-0000-000000000512', 'S2026012', 'ADM2026012', 6, 'Zoya Ahmed',
   '2010-10-09', 'female', '00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000304', '00000000-0000-0000-0000-000000000101', 'Farid Ahmed',   '+91-98100-00012', 'active'),
  ('00000000-0000-0000-0000-000000000513', 'S2026013', 'ADM2026013', 7, 'Arjun Reddy',
   '2010-04-05', 'male',   '00000000-0000-0000-0000-000000000202', '00000000-0000-0000-0000-000000000304', '00000000-0000-0000-0000-000000000101', 'Ravi Reddy',    '+91-98100-00013', 'active'),
  ('00000000-0000-0000-0000-000000000514', 'S2026014', 'ADM2026014', 1, 'Kavya Reddy',
   '2008-01-22', 'female', '00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-000000000305', '00000000-0000-0000-0000-000000000101', 'Ravi Reddy',    '+91-98100-00014', 'active'),
  ('00000000-0000-0000-0000-000000000515', 'S2026015', 'ADM2026015', 2, 'Manav Desai',
   '2008-03-16', 'male',   '00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-000000000305', '00000000-0000-0000-0000-000000000101', 'Nita Desai',    '+91-98100-00015', 'active'),
  ('00000000-0000-0000-0000-000000000516', 'S2026016', 'ADM2026016', 3, 'Riya Chawla',
   '2008-07-30', 'female', '00000000-0000-0000-0000-000000000203', '00000000-0000-0000-0000-000000000305', '00000000-0000-0000-0000-000000000101', 'Amit Chawla',   '+91-98100-00016', 'active')
) as v(
  id, student_number, admission_number, roll_number, full_name,
  date_of_birth, gender, class_id, section_id, academic_year_id,
  guardian_name, guardian_phone, status
)
on conflict (id) do nothing;

-- ── Exams ───────────────────────────────────────────────────────────────────────
-- `status` is checked against `('scheduled','ongoing','completed','cancelled')` —
-- there is no `draft` or `published`, so an exam that teachers can already mark is
-- `completed`, and one still in the future is `scheduled`.
insert into public.exams (id, academic_year_id, name, max_marks, weightage, exam_date, status)
values
  ('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000101', 'Unit Test 1',  50, 20, '2026-07-20', 'completed'),
  ('00000000-0000-0000-0000-000000000602', '00000000-0000-0000-0000-000000000101', 'Half Yearly', 80, 40, '2026-10-12', 'completed'),
  ('00000000-0000-0000-0000-000000000603', '00000000-0000-0000-0000-000000000101', 'Pre-Board',  100, 40, '2027-02-05', 'scheduled')
on conflict (id) do nothing;

-- ── Marks ───────────────────────────────────────────────────────────────────────
-- Deliberately absent.
--
-- `marks.entered_by` references `profiles(id)`, which is the Clerk user id — so marks
-- cannot be seeded here. `db reset` empties `profiles`, leaving no teacher to
-- attribute them to.
--
-- The two available workarounds are both wrong. Seeding a placeholder profile creates
-- a row nobody can ever sign in as, which then appears in the administrator's user
-- list as a phantom. Leaving `entered_by` pointing at a fabricated id produces marks
-- that no workflow could ever create.
--
-- Marks are entered the way they actually are: a signed-in teacher submitting them,
-- optionally from an OCR upload. That is a genuine path to test, so the absence of
-- seeded marks is not a gap in this file — it is the correct starting state.