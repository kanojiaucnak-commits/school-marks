-- =============================================================================
-- Fix `provision_profile_as()` — it threw on every call
--
-- ── The bug ────────────────────────────────────────────────────────────────────
--
-- 0013 contained this line:
--
--     v_name := nullif(btrim(coalesce(p_full_name, '')), '')
--               ?? split_part(v_email::text, '@', 1);
--
-- `??` is JavaScript's nullish-coalescing operator. It is not SQL. PL/pgSQL does
-- not parse a function body's expressions when the function is created, only when
-- it runs, so `CREATE OR REPLACE FUNCTION` succeeded and reported no problem —
-- and then every single call died with:
--
--     ERROR: 42883: operator does not exist: text ?? text
--
-- The visible symptom was nowhere near the cause. Provisioning always failed, so
-- `requireCaller()` reported "your sign-in account has no email address, so a
-- school profile cannot be created" — a message about Clerk, when the email had
-- been found perfectly well and the failure was a syntax error in this function.
--
-- ── Why a migration at all ─────────────────────────────────────────────────────
--
-- 0013 is applied, and applied migrations are immutable: editing the file would
-- desynchronise it from what the database actually contains, so that anyone
-- rebuilding from scratch gets something different from what is running.
--
-- ── The fix ────────────────────────────────────────────────────────────────────
--
-- `COALESCE` over two already-nulled expressions. `nullif(..., '')` turns a blank
-- string into NULL, which is what makes the coalesce fall through, so this
-- reproduces the intended semantics exactly.
-- =============================================================================

create or replace function public.provision_profile_as(
  p_user_id   text,
  p_email     text,
  p_full_name text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email citext;
  v_name  text;
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'A user id is required'
      using errcode = '42501';
  end if;

  v_email := nullif(btrim(coalesce(p_email, '')), '');
  if v_email is null then
    raise exception 'An email address is required to create a school profile'
      using errcode = 'P0002';
  end if;

  -- Prefer the supplied name; fall back to the local part of the address.
  v_name := coalesce(
             nullif(btrim(coalesce(p_full_name, '')), ''),
             nullif(split_part(v_email::text, '@', 1), '')
           );

  insert into public.profiles (id, email, full_name, role_id, status)
  values (p_user_id, v_email, coalesce(v_name, 'User'), 'role_teacher', 'active')
  on conflict (id) do nothing;

  -- Clerk owns the email, so keep ours in step with it.
  update public.profiles
     set email = v_email, updated_at = now()
   where id = p_user_id and email is distinct from v_email;

  return (select p from public.profiles p where p.id = p_user_id);
end;
$$;

-- Reassert the grants. `CREATE OR REPLACE` preserves existing privileges, so this is
-- belt-and-braces: it makes the intended access explicit at the definition rather
-- than relying on a grant made two migrations ago still being in place.
revoke execute on function public.provision_profile_as(text, text, text) from public;
revoke execute on function public.provision_profile_as(text, text, text) from anon;
revoke execute on function public.provision_profile_as(text, text, text) from authenticated;
grant execute on function public.provision_profile_as(text, text, text) to service_role;

-- A function that throws on every call is invisible to `CREATE FUNCTION` and to any
-- check that inspects only the catalogue, so exercise every branch here. A migration
-- that cannot prove its own function works is not finished.
--
-- Note on scope: `full_name` is deliberately written only when the row is created.
-- The email is refreshed on every call because Clerk owns it outright, but the name
-- is either Clerk's name at first sign-in or a local edit the school has made since,
-- and overwriting it with a derived email guess on every request would be worse than
-- leaving it alone.
--
-- Each row uses a distinct address because `profiles.email` carries a unique
-- constraint (`profiles_email_key`). Reusing one address across two ids raises 23505,
-- which is what caught this while the check was being written. Clerk guarantees an
-- address belongs to a single account on an instance, so two real users cannot collide
-- here — but the constraint is real and the test has to respect it.
do $$
declare
  v_named   text := 'user_selfcheck_named';
  v_blank   text := 'user_selfcheck_blank';
  v_null    text := 'user_selfcheck_null';
  v_result  public.profiles;
begin
  -- A supplied name is kept.
  v_result := public.provision_profile_as(v_named, 'selfcheck.named@example.test', 'Grace Hopper');
  assert v_result.email = 'selfcheck.named@example.test',
    'supplied email was not stored, got ' || coalesce(v_result.email::text, 'null');
  assert v_result.full_name = 'Grace Hopper',
    'supplied name was not kept, got ' || coalesce(v_result.full_name, 'null');
  assert v_result.role_id = 'role_teacher',
    'a new profile must default to role_teacher, got ' || v_result.role_id::text;
  assert v_result.status = 'active',
    'a new profile must be active, got ' || v_result.status::text;

  -- A blank name falls back to the local part of the address. Checked on a fresh
  -- row, since the name is only ever written at creation.
  v_result := public.provision_profile_as(v_blank, 'ada.lovelace@example.test', '   ');
  assert v_result.full_name = 'ada.lovelace',
    'blank name did not fall back to the email local part, got '
      || coalesce(v_result.full_name, 'null');

  -- A NULL name behaves the same as a blank one.
  v_result := public.provision_profile_as(v_null, 'grace.hopper@example.test', null);
  assert v_result.full_name = 'grace.hopper',
    'null name did not fall back to the email local part, got '
      || coalesce(v_result.full_name, 'null');

  -- On a repeat call the email is kept in step with Clerk...
  v_result := public.provision_profile_as(v_named, 'selfcheck.moved@example.test', 'Grace Hopper');
  assert v_result.email = 'selfcheck.moved@example.test',
    'email was not updated on a repeat call, got ' || coalesce(v_result.email::text, 'null');

  -- ...but the name is left alone, rather than being clobbered by a derived guess.
  assert v_result.full_name = 'Grace Hopper',
    'a repeat call overwrote the stored name, got ' || coalesce(v_result.full_name, 'null');

  -- A missing email is refused with a distinct code, so the caller can tell this
  -- apart from an infrastructure failure.
  begin
    perform public.provision_profile_as('user_should_not_exist', '   ');
    raise exception 'a blank email was accepted; the guard did not fire';
  exception
    when sqlstate 'P0002' then null;         -- the expected refusal
    when others then
      raise exception 'blank email raised % instead of P0002', sqlstate;
  end;

  assert not exists (select 1 from public.profiles where id = 'user_should_not_exist'),
    'a profile was created despite the blank email';

  -- A missing user id is refused too.
  begin
    perform public.provision_profile_as('  ', 'selfcheck.guard@example.test', null);
    raise exception 'a blank user id was accepted; the guard did not fire';
  exception
    when sqlstate '42501' then null;         -- the expected refusal
    when others then
      raise exception 'blank user id raised % instead of 42501', sqlstate;
  end;

  delete from public.profiles
   where id in (v_named, v_blank, v_null, 'user_should_not_exist');
end;
$$;