-- =============================================================================
-- Provisioning an email when the Clerk session token does not carry one
--
-- ── The problem ────────────────────────────────────────────────────────────────
--
-- `provision_current_profile()` read the email from the Clerk session token's
-- claims. That is a reasonable assumption and it was wrong: a Clerk session token
-- contains only
--
--     azp, exp, fva, iat, iss, nbf, sid, sts, sub, v
--
-- — there is no `email` claim unless the instance has been configured to add one.
-- A user signing in with Google therefore authenticated perfectly and still could
-- not be provisioned, because `profiles.email` is NOT NULL. Every authenticated
-- request failed with "Your sign-in account has no email address", which is both
-- true and completely misleading: their account *had* a verified email address,
-- the token just did not say so.
--
-- ── The fix ────────────────────────────────────────────────────────────────────
--
-- Ask Clerk. `verify_clerk_user()` calls the Clerk Backend API for the user id that
-- the *verified token* named, using the instance secret key, and reports what the
-- account actually holds. It is deliberately not given the email by the caller: the
-- browser must not be able to choose the address recorded against a profile.
--
-- The token claim is still preferred when present — it is free, and it avoids a
-- network call in the common case where an instance has been configured to include
-- it. Only when the claim is absent does this make a request.
--
-- ── Security ──────────────────────────────────────────────────────────────────
--
-- The function takes only a Clerk user id and returns only that user's own fields.
-- It is SECURITY DEFINER because it reads `auth.users`, which callers cannot, and it
-- derives nothing from the request other than that id — which has already been
-- cryptographically verified by `requireCaller` before this is ever reached.
--
-- HTTP calls out of Postgres are wrapped, because `http` raises on a non-2xx
-- response and an unhandled raise inside a trigger-less function would otherwise
-- surface as an opaque error.
-- =============================================================================

create extension if not exists http with schema extensions;

-- Clerk's FAPI. Overridable for self-hosted or proxied instances.
create or replace function public.clerk_api_base()
returns text
language sql
immutable
as $$
  select coalesce(
    (select decrypted_secret
       from vault.decrypted_secrets
      where name = 'clerk_api_base'
      limit 1),
    'https://api.clerk.com'
  );
$$;

/**
 * The Clerk instance secret key, read from Vault.
 *
 * Vault rather than a `app.settings.*` GUC because Supabase refuses
 * `ALTER DATABASE … SET "app.settings.…"` with `permission denied to set
 * parameter`, and a secret in a migration file would be committed to git.
 */
create or replace function public.clerk_secret_key()
returns text
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select decrypted_secret
    from vault.decrypted_secrets
   where name = 'clerk_secret_key'
   limit 1;
$$;

create or replace function public.verify_clerk_user(p_clerk_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_secret text;
  v_status integer;
  v_body   text;
begin
  if p_clerk_user_id is null or p_clerk_user_id = '' then
    return null;
  end if;

  v_secret := public.clerk_secret_key();
  if v_secret is null or v_secret = '' then
    return null;
  end if;

  -- `http` raises on a non-2xx, so the status is captured rather than allowed to
  -- throw. A missing or unauthorised account is a null result, not a crash.
  select status, content into v_status, v_body
    from extensions.http(
      'GET',
      public.clerk_api_base() || '/v1/users/' || p_clerk_user_id,
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_secret,
        'Accept', 'application/json'
      ),
      timeout_milliseconds := 5000
    );

  if v_status is null or v_status < 200 or v_status >= 300 then
    return null;
  end if;

  return v_body::jsonb;
exception
  when others then
    -- A network failure must not take down authentication. The caller falls back
    -- to its own error message.
    return null;
end;
$$;

create or replace function public.provision_current_profile()
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     text := public.current_clerk_id();
  v_claims jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_clerk  jsonb;
  v_email  citext;
  v_name   text;
begin
  if v_id is null then
    raise exception 'Not signed in'
      using errcode = '42501';
  end if;

  -- Prefer the token's own claim…
  v_email := nullif(
    btrim(coalesce(v_claims ->> 'email',
                   v_claims ->> 'primary_email_address',
                   v_claims ->> 'email_address', '')),
    ''
  );

  -- …but do not depend on it. Clerk only includes an email claim when the instance
  -- is configured to, and a default instance does not.
  if v_email is null then
    v_clerk := public.verify_clerk_user(v_id);

    v_email := nullif(
      btrim(coalesce(
        v_clerk -> 'primary_email_address' ->> 'email_address',
        v_clerk -> 'email_address' -> 0 ->> 'email_address',
        ''
      )),
      ''
    );

    -- A Google sign-in can carry the address under `identities` rather than at the
    -- top level, so that is checked too before giving up.
    if v_email is null and v_clerk is not null then
      select nullif(btrim(u.email_address), '')
        into v_email
        from jsonb_array_elements(
          coalesce(v_clerk -> 'identities', '[]'::jsonb)
        ) as u(email_address)
       where nullif(btrim(u.email_address), '') is not null
       limit 1;
    end if;

    v_name := nullif(
      btrim(coalesce(
        v_clerk ->> 'first_name',
        v_clerk ->> 'last_name',
        v_clerk ->> 'username'
      )),
      ''
    );
  end if;

  if v_email is null then
    -- Now genuinely account-level: no claim and nothing in Clerk either.
    raise exception 'No email address is available for this account, so a school profile cannot be created'
      using errcode = 'P0002';
  end if;

  if v_name is null then
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
  end if;

  insert into public.profiles (id, email, full_name, role_id, status)
  values (v_id, v_email, coalesce(v_name, 'User'), 'role_teacher', 'active')
  on conflict (id) do nothing;

  -- Clerk owns the email, so keep ours in step with it. A separate statement,
  -- because an ON CONFLICT DO UPDATE ... WHERE would have to qualify the target
  -- column, which is easy to get subtly wrong.
  update public.profiles
     set email = v_email, updated_at = now()
   where id = v_id and email is distinct from v_email;

  return (select p from public.profiles p where p.id = v_id);
end;
$$;

grant execute on function public.provision_current_profile() to authenticated;
grant execute on function public.verify_clerk_user(text) to service_role;