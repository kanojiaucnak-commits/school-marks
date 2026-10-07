-- =============================================================================
-- Only an administrator may change a role or a status
--
-- `profiles_admin_all` is documented in 0002 as the "administrators may edit
-- anyone" policy, but it was gated on `has_permission('user:update')` — and
-- `role_teacher` is granted `user:update` in 0003, because a teacher may edit
-- their own name and phone. The policy carried no row scope at all, so holding
-- that permission made a caller satisfy it for *every* profile, not just their
-- own.
--
-- `prevent_self_role_escalation` was the second half of the same defence and
-- asked the same wrong question: it raised only `if ... and not
-- has_permission('user:update')`. Teachers hold that permission, so for a
-- teacher the condition was false and the guard never fired.
--
-- Together those two facts meant any signed-in teacher could write
-- `role_id = 'role_admin'` on their own row and promote themselves, and could
-- demote or deactivate anyone else. It did not even take a crafted request:
-- `/app/teachers` has no permission guard (only the sidebar link is hidden), so
-- opening the URL, picking their own row and choosing "Administrator" was
-- enough.
--
-- Two changes, and both are required:
--
--   1. `profiles_admin_all` now requires the administrator role. This is what
--      the 0002 comment and the ProfilePage comment both already claimed it did.
--
--   2. The escalation trigger now asks whether the caller is an administrator
--      rather than whether they hold `user:update`, and covers `status` as well
--      as `role_id` — 0002 says "only admins may change role or status".
--
-- Nothing legitimate regresses. Self-service edits run through
-- `profiles_update_self`, which matches `id = current_clerk_id()` and is left
-- exactly as it was, so anyone can still change their own name, phone and
-- employee code. Provisioning and the last-admin guard are SECURITY DEFINER or
-- unaffected: neither writes `role_id`/`status` on a row belonging to the
-- caller.
--
-- The hard-coded `'role_admin'` matches how 0011 already identifies the role it
-- protects, rather than introducing a second vocabulary for the same idea.
-- =============================================================================

drop policy profiles_admin_all on public.profiles;

create policy profiles_admin_all on public.profiles
  for all to authenticated
  using (public.current_role() = 'role_admin')
  with check (public.current_role() = 'role_admin');

create or replace function public.prevent_self_role_escalation()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  -- Reaching your own row is always possible through `profiles_update_self`,
  -- so this trigger is the only thing standing between a user and promoting
  -- themselves. An administrator may still change their own role or status;
  -- nobody else may change those two columns on their own row at all.
  if new.id = public.current_clerk_id()
     and public.current_role() <> 'role_admin' then
    if new.role_id is distinct from old.role_id then
      raise exception 'only an administrator may change your own role';
    end if;
    if new.status is distinct from old.status then
      raise exception 'only an administrator may change your own status';
    end if;
  end if;
  return new;
end;
$$;
