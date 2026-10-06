-- =============================================================================
-- Retire the superseded provisioning paths
--
-- ── Background ─────────────────────────────────────────────────────────────────
--
-- Provisioning a profile on first sign-in is now done in exactly one place: the
-- `data-proxy` Edge Function's `requireCaller()`, which resolves the account's
-- email from the Clerk Backend API and calls `provision_profile_as()`.
--
-- Two earlier paths are being removed here, both of which read the email from the
-- Clerk *session token*:
--
--   1. `provision_current_profile()` — called directly by the browser via
--      `rpc('provision_current_profile')`.
--   2. `verify_clerk_user()` — a Postgres-to-Clerk HTTP lookup added in 0012.
--
-- ── Why they are removed rather than fixed ─────────────────────────────────────
--
-- They failed for every user on a default Clerk instance. A session token carries
-- only `azp, exp, fva, iat, iss, nbf, sid, sts, sub, v` — there is no `email` claim
-- unless the instance is explicitly configured to add one — while `profiles.email`
-- is NOT NULL. So a user who authenticated perfectly was refused a profile and
-- locked out, with the misleading message that their account had no email address.
--
-- They are also unreachable. `provision_current_profile()` was the browser's
-- fallback, but `requireCaller()` provisions first, so by the time the fallback
-- could run the row already existed. Keeping dead code that duplicates the
-- authorisation path is the actual hazard: it is a browser-reachable way to create
-- a profile, and it is the copy most likely to drift from the real one.
--
-- `verify_clerk_user()` never worked either. The `http` extension's second
-- argument is a request *body*, not headers (`http_get(uri, data jsonb)`), so the
-- `Authorization` header could not be sent the way the function assumed and Clerk
-- answered 401.
--
-- ── `clerk_secret_key()` and the Vault secret ──────────────────────────────────
--
-- `clerk_secret_key()` existed only for `verify_clerk_user()`. With that gone,
-- nothing reads it, so it goes too — leaving a `SECURITY DEFINER` function whose
-- only purpose was to read a stored credential is not a risk worth carrying. The
-- Vault entries are deleted below for the same reason.
--
-- The secret still lives where it is needed: as the `CLERK_SECRET_KEY` Edge
-- Function environment variable.
-- =============================================================================

drop function if exists public.provision_current_profile();
drop function if exists public.verify_clerk_user(text);
drop function if exists public.clerk_secret_key();
drop function if exists public.clerk_api_base();

-- `http` was only ever needed by `verify_clerk_user()`.
drop extension if exists http cascade;

-- A direct delete rather than `vault.delete_secret()`: this Vault version ships no
-- delete function at all, only `vault.create_secret()`. `vault.secrets` carries no
-- triggers, so there is no derived state left dangling by removing the rows.
delete from vault.secrets where name in ('clerk_secret_key', 'clerk_api_base');

-- Nothing should still depend on these.
do $$
declare
  v_left text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_left
    from pg_proc p
   where p.proname in (
     'provision_current_profile',
     'verify_clerk_user',
     'clerk_secret_key',
     'clerk_api_base'
   )
   and p.pronamespace = 'public'::regnamespace;

  if v_left is not null then
    raise exception 'these provisioning functions still exist: %', v_left;
  end if;
end;
$$;