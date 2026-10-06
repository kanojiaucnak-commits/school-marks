-- =============================================================================
-- Grading was non-deterministic at every band boundary, and the editor could
-- never save the seeded scheme
--
-- ── The three defects ──────────────────────────────────────────────────────────
--
-- 1. `grade_for_percentage` had no `ORDER BY`.
--
--       select r.grade, r.grade_point, r.is_pass
--         from public.grading_rules r
--        where … r.scheme_id = … and p_pct >= r.min_percentage
--          and p_pct <= r.max_percentage
--        limit 1;
--
--    `limit 1` without `order by` returns whichever row the plan happens to
--    produce first. That is only correct when at most one band can match, and the
--    seeded scheme breaks that at every boundary because its bands are inclusive on
--    both ends:
--
--        A+  90 – 100
--        A   80 –  90     <- 90.00 matches both A+ and A
--
--    A student sitting exactly on a boundary was therefore graded by the planner.
--    Observed on this database: Aarav Sharma at 90.00% was stored as `A` when the
--    live preview in the marks grid showed `A+`, for the same number.
--
-- 2. The trigger behind those columns left a stale grade when nothing matched.
--
--       select g.grade, g.grade_point, g.is_pass
--         into new.grade, new.grade_point, new.is_pass
--         from public.grade_for_percentage(pct, scheme) g;
--
--    A `select … into` that matches no rows leaves the targets untouched, and in a
--    trigger they already hold the row's previous values. A percentage falling into
--    a gap between bands therefore kept whatever grade the student had last been
--    given — a mark edit silently failed to regrade. `percentage` was updated in
--    the line above, so the row reported a new percentage beside a stale letter.
--
-- 3. The seeded scheme was shaped in a way the application rejects.
--
--    `GradingPage.tsx` validates `current.min <= previous.max` as an overlap, so
--    `A 80 – 90` next to `A+ 90 – 100` fails. Opening "Edit bands" on the one scheme
--    in the database therefore showed a permanent overlap error with Save disabled,
--    and the scheme could not be edited at all. The bands are the reference data the
--    whole grading feature is built on, so it had to be corrected to the shape the
--    app actually accepts: a band ends where the next begins.
--
--    `save_grading_scheme` compounded this by validating nothing at all, despite
--    `academic.ts` commenting that "the overlapping-band validation belongs in one
--    place". It was reachable directly and would accept inverted bands (`min > max`),
--    bands outside 0-100, non-numeric input, and gaps — the gap case being the one
--    that feeds defect 2.
--
-- ── The fix ────────────────────────────────────────────────────────────────────
--
-- `order by r.min_percentage desc` makes the lookup deterministic and resolves a
-- shared boundary to the higher band, which is what "A+: 90-100" means and what the
-- frontend preview already showed. Bands are then repaired into a clean partition on
-- the two-decimal grid the `percentage` column uses, so the common case has no
-- ambiguity to resolve at all. The trigger nulls the grade rather than keeping a
-- stale one. `save_grading_scheme` gains the validation the editor's comment
-- promised, covering gaps as well as overlaps.
--
-- Finally, existing marks are re-derived: the deterministic boundary rule changes
-- the answer for rows sitting exactly on one, and the trigger only fires on an
-- update of `marks_obtained`, `max_marks` or `status`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Deterministic band lookup
-- -----------------------------------------------------------------------------

create or replace function public.grade_for_percentage(p_pct numeric, p_scheme uuid default null)
returns table(grade text, grade_point numeric, is_pass boolean)
language sql
stable
set search_path = public, pg_temp
as $$
  select r.grade, r.grade_point, r.is_pass
    from public.grading_rules r
   where r.scheme_id = coalesce(p_scheme, public.active_scheme_id())
     and p_pct >= r.min_percentage
     and p_pct <= r.max_percentage
   order by r.min_percentage desc, r.sort_order asc, r.max_percentage asc
   limit 1;
$$;

comment on function public.grade_for_percentage(numeric, uuid) is
  'Resolve a percentage to a grade band. Ordered highest band first so a percentage '
  'sitting on a shared boundary is deterministic, and always matches the live '
  'preview in the marks grid.';

-- -----------------------------------------------------------------------------
-- 2. Never carry a stale grade forward
-- -----------------------------------------------------------------------------

create or replace function public.marks_derive_grade()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  pct    numeric(5,2);
  scheme uuid;
begin
  if new.status is distinct from 'PRESENT' or new.marks_obtained is null then
    new.percentage  := null;
    new.grade       := null;
    new.grade_point := null;
    new.is_pass     := null;
    return new;
  end if;

  if new.max_marks is null or new.max_marks <= 0 then
    return new;   -- table CHECK will reject this
  end if;

  pct := round((new.marks_obtained / new.max_marks) * 100, 2);
  new.percentage := pct;

  scheme := public.active_scheme_id();

  select g.grade, g.grade_point, g.is_pass
    into new.grade, new.grade_point, new.is_pass
    from public.grade_for_percentage(pct, scheme) g;

  -- A `select … into` that matches nothing leaves the targets alone, and in a
  -- trigger they still hold the previous row's values — so the student kept the
  -- grade they had before the edit. Clearing them is the honest answer: a
  -- percentage no band covers must not be reported as the last known grade.
  if not found then
    new.grade       := null;
    new.grade_point := null;
    new.is_pass     := null;
  end if;

  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Bands are a partition, not a set of overlapping inclusive ranges
-- -----------------------------------------------------------------------------

-- Only narrows a band that actually reaches into the one above it, and never past its
-- own start, so two bands sharing a `min_percentage` are left alone for the new
-- constraint below to reject. A scheme that is already a clean partition is untouched.
--
-- `lead()` over bands ordered ascending by `min_percentage` yields the band above, and
-- null for the top band, which is the one that must keep its 100.
with ordered as (
  select id,
         lead(min_percentage) over (partition by scheme_id order by min_percentage) as next_min
    from public.grading_rules
)
update public.grading_rules gr
   set max_percentage = o.next_min - 0.01
  from ordered o
 where gr.id = o.id
   and o.next_min is not null
   and gr.max_percentage >= o.next_min
   and o.next_min - 0.01 >= gr.min_percentage;

-- The table never rejected an inverted band, so `A 90 - 80` could be stored and then
-- matched nothing at all. Kept as its own constraint rather than folded into the
-- existing range check, so the two guarantees stay separately identifiable.
alter table public.grading_rules
  drop constraint if exists grading_rules_band_order_check;
alter table public.grading_rules
  add constraint grading_rules_band_order_check
  check (max_percentage >= min_percentage);

-- -----------------------------------------------------------------------------
-- 4. The validation the editor's comment claimed
-- -----------------------------------------------------------------------------

create or replace function public.save_grading_scheme(
  p_scheme_id   uuid,
  p_name        text,
  p_rules       jsonb,
  p_description text default null,
  p_is_default  boolean default false
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_id          uuid;
  v_was_default boolean;
  v_bands       numeric[][];   -- [ { from, to }, … ] ascending by `from`
  v_labels      text[];         -- the grade label for each entry in v_bands
  v_last        numeric;
  i             integer;
begin
  -- ── Validation ──────────────────────────────────────────────────────────────
  -- Every failure mode below produced a scheme that graded students wrongly or not
  -- at all, and each is reachable by calling the RPC directly. The editor in
  -- `GradingPage.tsx` enforces part of this; it cannot be the only thing that does.
  if p_rules is null or jsonb_array_length(p_rules) = 0 then
    raise exception 'A grading scheme needs at least one grade band.' using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_rules) as r
     where btrim(coalesce(r ->> 'grade', '')) = ''
  ) then
    raise exception 'Every grade band needs a grade label.' using errcode = '22023';
  end if;

  -- Checked as text before casting so a non-numeric entry reports that the band is
  -- malformed rather than surfacing as a bare 22P02 from the cast below.
  if exists (
    select 1
      from jsonb_array_elements(p_rules) as r
     where coalesce(r ->> 'minPercentage', '') !~ '^\d+(\.\d+)?$'
        or coalesce(r ->> 'maxPercentage', '') !~ '^\d+(\.\d+)?$'
  ) then
    raise exception 'Every grade band needs a numeric "from %%" and "to %%".' using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_rules) as r
     where (r ->> 'minPercentage')::numeric < 0
        or (r ->> 'minPercentage')::numeric > 100
        or (r ->> 'maxPercentage')::numeric < 0
        or (r ->> 'maxPercentage')::numeric > 100
  ) then
    raise exception 'Grade bands must fall between 0%% and 100%%.' using errcode = '22023';
  end if;

  select array_agg(array[lo, hi] order by lo, hi, label),
         array_agg(label        order by lo, hi, label)
    into v_bands, v_labels
    from (
      select (r ->> 'grade')::text           as label,
             (r ->> 'minPercentage')::numeric as lo,
             (r ->> 'maxPercentage')::numeric as hi
        from jsonb_array_elements(p_rules) as r
    ) as parsed;

  -- Each band must end before the next one begins — the rule the editor applies, and
  -- the one the seeded scheme violated with `A 80-90` under `A+ 90-100`.
  --
  -- The other half of the rule is contiguity. Overlap-free bands can still leave a
  -- hole, and a percentage inside a hole matched no band at all, which
  -- `marks_derive_grade` now reports as a null grade: an ungraded student on an
  -- otherwise complete marksheet. `0.01` is one step on the two-decimal grid
  -- `marks.percentage` is stored on, so `89.99` followed by `90` counts as adjacent
  -- while a band ending at `89.9` leaves 89.91-89.99 ungraded and is refused.
  for i in 1 .. coalesce(array_length(v_bands, 1), 1) - 1 loop
    if v_bands[i][2] >= v_bands[i + 1][1] then
      raise exception 'Grade bands must not overlap: % covers up to %, which % reaches back to %.',
        v_labels[i], v_bands[i][2], v_labels[i + 1], v_bands[i + 1][1]
        using errcode = '22023';
    end if;

    if v_bands[i][2] < v_bands[i + 1][1] - 0.01 then
      raise exception 'Grade bands leave a gap: % ends at %, but % starts at %.',
        v_labels[i], v_bands[i][2], v_labels[i + 1], v_bands[i + 1][1]
        using errcode = '22023';
    end if;
  end loop;

  if v_bands[1][1] <> 0 then
    raise exception 'The lowest grade band must start at 0, not %.', v_bands[1][1]
      using errcode = '22023';
  end if;

  v_last := v_bands[array_length(v_bands, 1)][2];

  if v_last <> 100 then
    raise exception 'The highest grade band must end at 100, not %.', v_last
      using errcode = '22023';
  end if;

  -- ── Persist ─────────────────────────────────────────────────────────────────

  if p_scheme_id is null then
    insert into public.grading_schemes (name, description, is_default)
    values (p_name, p_description, p_is_default)
    returning id into v_id;
  else
    select is_default into v_was_default
      from public.grading_schemes
     where id = p_scheme_id
     for update;

    if not found then
      raise exception 'Grading scheme % not found', p_scheme_id using errcode = 'P0002';
    end if;

    update public.grading_schemes
       set name = p_name, description = p_description, is_default = p_is_default
     where id = p_scheme_id
    returning id into v_id;

    -- The partial unique index allows only one default; stand the old one down
    -- inside the same transaction so the swap can never transiently violate it.
    if p_is_default and not v_was_default then
      update public.grading_schemes set is_default = false where id <> v_id and is_default;
    end if;

    delete from public.grading_rules where scheme_id = v_id;
  end if;

  insert into public.grading_rules
    (scheme_id, grade, min_percentage, max_percentage, grade_point, is_pass, sort_order)
  select v_id,
         r ->> 'grade',
         (r ->> 'minPercentage')::numeric,
         (r ->> 'maxPercentage')::numeric,
         (r ->> 'gradePoint')::numeric,
         coalesce((r ->> 'isPass')::boolean, true),
         coalesce((r ->> 'sortOrder')::integer, 0)
    from jsonb_array_elements(p_rules) as r;

  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Re-derive grades already on file
-- -----------------------------------------------------------------------------
-- The boundary rule changes the stored answer for a row sitting exactly on one, and
-- `trg_marks_derive_grade` only fires on an update of `marks_obtained`, `max_marks`
-- or `status`, so the rows would otherwise keep the old letter indefinitely. Writing
-- the column to itself is enough: the trigger is `before update of marks_obtained`.
update public.marks set marks_obtained = marks_obtained
 where status = 'PRESENT' and marks_obtained is not null;