-- =============================================================================
-- Provision a profile using identity resolved by the Edge Function
--
-- ── Why this exists ────────────────────────────────────────────────────────────
--
-- `provision_current_profile()` read the email from the Clerk session token. Clerk
-- only includes an email claim when an instance is configured to, and a default
-- instance does not — a real token from this project carried only:
--
--     azp, exp, fva, iat, iss, nbf, sid, sts, sub, v
--
-- So a user who authenticated perfectly (this one via Google, with a verified
-- email on the account) could not be provisioned, because `profiles.email` is NOT
-- NULL. Every authenticated request failed with "your account has no email
-- address", which was both true and misleading.
--
-- ── Why the lookup happens in the Edge Function, not in SQL ───────────────────
--
-- The first attempt had Postgres call Clerk's API directly. It is possible but a
-- poor fit: the `http` extension's second argument is a request *body*, not
-- headers (`http_get(uri, data jsonb)`), so an `Authorization` header has to be
-- smuggled through the extension's curl-style `http_header()` session state. That
-- is fragile, stateful and awkward inside a function that may run concurrently.
--
-- The Edge Function already holds `CLERK_SECRET_KEY` and already verifies the
-- caller's token, so it can resolve the identity and hand the result over. This
-- function is the receiving end.
--
-- ── Why the browser cannot reach this ──────────────────────────────────────────
--
-- `provision_profile_as` takes an explicit user id, which would be a privilege
-- escalation if any authenticated caller could invoke it: they could provision a
-- profile for somebody else, with an email of their choosing. So EXECUTE is
-- revoked from `authenticated`, `anon` and `public`, leaving only `service_role`
-- — which never leaves the server. The user id is therefore always the one
-- `requireCaller()` cryptographically verified, and the email is always the one
-- Clerk reports for that id.
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

  v_name := nullif(btrim(coalesce(p_full_name, '')), '')
            ?? split_part(v_email::text, '@', 1);

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

-- Locked down to the service role. Without this any signed-in user could call it
-- directly with an arbitrary id and email.
revoke execute on function public.provision_profile_as(text, text, text) from public;
revoke execute on function public.provision_profile_as(text, text, text) from anon;
revoke execute on function public.provision_profile_as(text, text, text) from authenticated;
grant execute on function public.provision_profile_as(text, text, text) to service_role;

-- `provision_current_profile()` stays for a Clerk instance that *does` include an
-- email claim, but must no longer be the only path — otherwise a default instance
-- locks every new user out.
revoke execute on function public.provision_current_profile() from public;
grant execute on function public.provision_current_profile() to authenticated;