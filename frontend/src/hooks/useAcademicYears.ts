import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { AcademicYear } from '@school/shared';
import { getCurrentAcademicYear, listAcademicYears } from '../lib/repos/academic';

/**
 * One owner for the academic-year query.
 *
 * ── Why this hook exists ────────────────────────────────────────────────────
 *
 * Twelve call sites used the cache key `'academic-years'`, and they disagreed
 * about what lives under it. Three different shapes were stored at that one key:
 *
 *   - `AppLayout` and nine pages cached `{ academicYears, current }`
 *   - `ExportsPage` and `ReviewQueuePage` cached a bare `AcademicYear[]`
 *   - `AcademicYearsPage` cached the `useListQuery` envelope, via its `key:`
 *
 * React Query caches by key, not by type, so whichever component mounted first
 * decided the shape and the rest read it as if it were their own. That is not a
 * subtle degradation but a white screen: `ExportsPage` did
 * `(years ?? []).map(...)` against an object, threw, and — because the app has
 * no error boundary — took the whole SPA down with it.
 *
 * The copies also differed in a way the crash merely made visible. `AppLayout`
 * and `MarksEntryPage` asked for `listAcademicYears()` (active only) while the
 * other nine asked for `listAcademicYears(true)`. The cached result was
 * therefore whichever request landed first, so whether an archived year appeared
 * in a report's year filter depended on navigation order.
 *
 * One hook fixes both: one `queryFn`, one shape, and the flag folded into the
 * key so the two variants cannot collide with each other either.
 *
 * ── Key shape ───────────────────────────────────────────────────────────────
 *
 * `'academic-years'` remains the first element so prefix invalidation keeps
 * working. `AcademicYearsPage`'s mutations call
 * `invalidateQueries({ queryKey: ['academic-years'] })`, which matches on
 * prefix — so a newly created year still refreshes every selector in the app.
 */

export interface AcademicYearsResult {
  /** Every year the caller may see, newest first. */
  academicYears: AcademicYear[];
  /** The year flagged `is_current`, or `null` if none is. */
  current: AcademicYear | null;
}

export interface AcademicYearsOptions {
  /**
   * Include archived years in `academicYears`. Defaults to `true`: every caller
   * of this is a year *filter*, and a filter for a past year is useless if the
   * past year is missing from it.
   */
  includeArchived?: boolean;
  /** Skip the query entirely — e.g. while the user is signed out. */
  enabled?: boolean;
}

/** Academic years plus the current one. */
export function useAcademicYears(
  options: AcademicYearsOptions = {},
): UseQueryResult<AcademicYearsResult> {
  const { includeArchived = true, enabled = true } = options;

  return useQuery({
    queryKey: ['academic-years', 'pair', { includeArchived }],
    queryFn: async (): Promise<AcademicYearsResult> => {
      // Sequential rather than `Promise.all`: these are two round trips through
      // the same pooled connection, and the pool is the slow part here.
      const academicYears = await listAcademicYears(includeArchived);
      const current = await getCurrentAcademicYear();
      return { academicYears, current };
    },
    staleTime: 10 * 60_000,
    enabled,
  });
}

/**
 * The year list alone, as a real array even before the query settles.
 *
 * For filters that do not care which year is current, so a `<Select>` can map
 * over the result directly instead of defending itself with `?? []` at every
 * call site.
 */
export function useAcademicYearOptions(
  options: AcademicYearsOptions = {},
): UseQueryResult<AcademicYearsResult> & { academicYears: AcademicYear[] } {
  const query = useAcademicYears(options);
  return { ...query, academicYears: query.data?.academicYears ?? [] };
}