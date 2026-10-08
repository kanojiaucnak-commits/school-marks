-- =============================================================================
-- 0026 · Let the administrator ask for a class like any teacher
-- =============================================================================
--
-- `assignment:request` is the one permission that was deliberately withheld from
-- `role_admin`: 0003 omits it from the admin array and 0008 grants it to
-- `role_teacher` alone. The reasoning on record was that asking is meaningless
-- when `assignment:manage` already lets an administrator assign anyone to
-- anything directly.
--
-- That holds for somebody who only administers. It stops holding once the
-- administrator also teaches, because `request_assignment` refuses the call
-- without this permission — so the request form on `My classes` took their
-- input, sent it, and failed at the server. Granting it makes the admin an
-- ordinary participant in the one self-service path instead of a special case,
-- and it introduces no second mechanism: approval still goes through
-- `decide_assignment_request`, which writes the same `teacher_assignments` row
-- that `AssignmentsPage` writes by hand.
--
-- Nothing else changes. `role_teacher` and `role_reviewer` are untouched, and
-- `on conflict do nothing` makes this safe to run twice.
-- -----------------------------------------------------------------------------

insert into public.role_permissions (role_id, permission)
select 'role_admin', p
from unnest(array[
  'assignment:request'
]) as p
on conflict do nothing;
