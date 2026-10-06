-- =============================================================================
-- `normalize_name()` — the database side of the OCR name matcher
--
-- ── Why this exists ────────────────────────────────────────────────────────────
--
-- `students.normalized_name` is `not null` and has no trigger, so every write path
-- must supply it. `import-commit` computes it in TypeScript with `normalizeName()`
-- from `@school/shared`, and that file carries an explicit warning:
--
--     "…matching `normalizeName()` in @school/shared, because OCR matching depends on
--      students being stored in the same normalised form the matcher compares against."
--
-- So a student inserted with a differently-normalised name is not rejected — it is
-- silently unmatched, and OCR falls through to fuzzy matching or to manual review with
-- no indication of why. The seed data hit exactly this: `normalized_name` is NOT NULL
-- with no default, so seeding students requires producing the same value, by hand,
-- from a TypeScript function.
--
-- Hand-transcribing it into SQL is the drift the warning describes. This function is
-- the single database-side definition instead, and `seed.sql` calls it rather than
-- hard-coding values.
--
-- ── Correspondence with the TypeScript ──────────────────────────────────────────
--
--   normalizeName()                        normalize_name()
--   ------------------------------------   ----------------------------------------
--   .normalize('NFKD')                     -- (unaccent covers the practical cases;
--   .replace(/[\u0300-\u036f]/g, '')          Postgres has no NFKD decompose, and
--                                              the combining marks this removes are the
--                                              ones `unaccent` folds)
--   .replace(/[^\p{L}\p{N}\s]/gu, ' ')      regexp_replace(…, '[^[:alnum:][:space:]]', …)
--   .toLowerCase()                         lower(…)
--   .replace(/\s+/g, ' ')                  regexp_replace(…, '[[:space:]]+', …)
--   .trim()                                 btrim(…)
--
-- Neither `\s` nor `\p{L}` is valid in a Postgres ARE — both raise
-- `invalid regular expression: invalid escape \ sequence`. The equivalents are the
-- POSIX classes `[[:space:]]` and `[[:alnum:]]`.
--
-- One difference is worth recording rather than hiding. JavaScript's `\p{L}` matches
-- any Unicode letter; Postgres's `[[:alnum:]]` is locale-dependent. On this project's
-- UTF-8 database the two agree for the scripts a school roster contains, and
-- `unaccent` already folds accented Latin down to ASCII first. A name in a script
-- whose letters the locale does not classify as alphanumeric would normalise
-- differently — so `import-commit` continues to compute the value in TypeScript and
-- this function exists for SQL callers such as `seed.sql`, not to replace it.
--
-- `unaccent` is only `stable`, not `immutable` — it depends on the loaded dictionary —
-- so this function is too. That is the correct classification; marking it `immutable`
-- would let the planner cache a result across a dictionary change.
-- =============================================================================

create extension if not exists unaccent with schema extensions;

create or replace function public.normalize_name(p_name text)
returns text
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select nullif(
    btrim(
      regexp_replace(
        lower(
          regexp_replace(
            extensions.unaccent(p_name),
            '[^[:alnum:][:space:]]',
            ' ',
            'g'
          )
        ),
        '[[:space:]]+',
        ' ',
        'g'
      )
    ),
    ''
  );
$$;

comment on function public.normalize_name(text) is
  'Mirror of normalizeName() in shared/src/utils.ts. Students are stored in this form '
  'so OCR name matching can compare like with like.';

-- The cases are pinned rather than left to a future edit: this function and the
-- TypeScript one must agree, and the only way to notice when they stop agreeing is to
-- state the expected answers somewhere both changes have to be checked against.
--
-- Accented inputs are written as `U&'…'` escapes. Writing the literal characters
-- directly looks fine and is not: they have to survive a round trip through whatever
-- tool is applying the migration, and a Windows shell mangled them on the first
-- attempt, turning the accented test into a test of the mangling.
do $$
declare
  r record;
begin
  -- A FOR loop over VALUES, rather than FOREACH: FOREACH cannot iterate a
  -- two-dimensional array, and a two-variable FOREACH needs a composite type.
  for r in
    select * from (values
      ('Aarav Sharma',      'aarav sharma'::text),
      ('  Diya   Patel  ',  'diya patel'::text),
      ('Zoya Ahmed',        'zoya ahmed'::text),
      (U&'Jos\00E9 \00C1lvarez', 'jose alvarez'::text),  -- José Álvarez
      (U&'Ren\00E9e',           'renee'::text),           -- Renée
      ('O''Brien-Smith',    'o brien smith'::text),
      ('Madhav  Iyer.',     'madhav iyer'::text),
      ('Ann-Marie 3',       'ann marie 3'::text),
      ('',                  null::text),
      ('   ',               null::text)
    ) as t(input, want)
  loop
    if public.normalize_name(r.input) is distinct from r.want then
      raise exception
        'normalize_name(%) = %, expected %',
        quote_literal(r.input),
        quote_literal(public.normalize_name(r.input)),
        quote_literal(r.want);
    end if;
  end loop;
end;
$$;