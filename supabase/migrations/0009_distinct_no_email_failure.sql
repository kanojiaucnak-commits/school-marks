-- =============================================================================
-- Distinguishable "no email address" failure
--
-- `provision_current_profile()` rejects a Clerk account that carries no email
-- address, because `profiles.email` is NOT NULL and UNIQUE. That path is
-- genuinely reachable: a Clerk instance can be configured so that sign-up does
-- not collect an email, and then an account exists with an id and nothing else.
--
-- It was raised as SQLSTATE 22023 (invalid_parameter_value), which is also what
-- the routine validation failures below it use. Callers therefore could not tell
-- "your account is missing an email — a one-line fix on your side" apart from
-- "something went wrong", and both collapse into the same advice.
--
-- 0008 is already applied, so this is a new migration rather than an edit to it:
-- applied migrations are immutable, and rewriting one would mean a database built
-- from scratch and this database disagreed about what the function does.
--
-- P0002 (raise_exception, no_data_found class) is used purely as a distinct
-- signal. Nothing depends on the specific class, only on it being distinguishable.
-- =============================================================================

create or replace function public.provision_current_profile()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     text := public.current_clerk_id();
  v_claims jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_email  citext;
  v_name   text;
begin
  if v_id is null then
    raise exception 'Not signed in'
      using errcode = '42501';
  end if;

  v_email := nullif(
    btrim(coalesce(v_claims ->> 'email',
                   v_claims ->> 'primary_email_address',
                   v_claims ->> 'email_address', '')),
    ''
  );

  v_name := nullif(
    btrim(coalesce(
      v_claims ->> 'name',
      v_claims ->> 'full_name',
      nullif(btrim(coalesce(v_claims ->> 'given_name', '') || ' '
                    || coalesce(v_claims ->> 'family_name', '')), ''),
      split_part(coalesce(v_email::text, ''), '@', 1)
    )),
    ''
  );

  if v_email is null then
    raise exception 'Your sign-in provider did not supply an email address, so an account cannot be created'
      using errcode = 'P0002';
  end if;

  insert into public.profiles (id, email, full_name, role_id, status)
  values (v_id, v_email, coalesce(v_name, 'User'), 'role_teacher', 'active')
  on conflict (id) do nothing;

  -- Clerk owns the email, so keep ours in step with it. Done as a separate
  -- statement: an ON CONFLICT DO UPDATE ... WHERE would need to qualify the
  -- target column, which is awkward and easy to get subtly wrong.
  update public.profiles
     set email = v_email, updated_at = now()
   where id = v_id and email is distinct from v_email;

  return (select p from public.profiles p where p.id = v_id);
end;
$$;

grant execute on function public.provision_current_profile() to authenticated;