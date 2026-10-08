-- =============================================================================
-- A class teacher must be able to see the roster they are marking
--
-- 0022 widened `can_read_sheet` and `can_write_sheet` so the class teacher may
-- work on every subject in their own section rather than only the subject rows
-- they happen to hold. `students_read`, written in 0008, was never widened with
-- it: it still allows only `student:view_all`, or `student:view` together with a
-- `teacher_assignments` row for that section.
--
-- The two are not independent. `getMarksGrid` does not read a marks table to
-- discover who to score — its first query is `v_students` for the roster. So a
-- class teacher with no subject rows satisfies `can_write_sheet` and is then
-- handed an empty sheet: the database permits the write and there is nothing to
-- write on. That is the shape of the reported failure — the entry screen opens
-- and every student is absent from it.
--
-- `0023` states that its gate "mirrors the read policy in 0008 exactly — the
-- same three callers, evaluated the same way". It does not: `can_insert_student`
-- already carries `is_class_teacher_of()`. This brings `students_read` in line
-- with it, so a teacher who may file a student into a section is a teacher who
-- may also see that section.
--
-- This widens rather than narrows, and only within the class teacher's own
-- section: `student:view` is still required, and `is_class_teacher_of()` already
-- scopes both by `sections.class_teacher_id` and by the student's academic year.
-- A teacher who is not a class teacher of that section is unaffected, and no
-- other role gains anything it did not have.
-- =============================================================================

drop policy if exists students_read on public.students;

create policy students_read on public.students
  for select to authenticated
  using (
    public.has_permission('student:view_all')
    or (
      public.has_permission('student:view')
      and (
           public.is_assigned_to_section(students.section_id, students.academic_year_id)
        or public.is_class_teacher_of(students.section_id, students.academic_year_id)
      )
    )
  );
