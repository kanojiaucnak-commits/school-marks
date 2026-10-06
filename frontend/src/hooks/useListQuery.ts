import { useCallback, useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QueryError, type ListResponse } from '../lib/query';

/**
 * Shared list-query state for paginated tables.
 *
 * Every list screen needs the same four things — a page, a debounced search,
 * filter state and a query — plus two subtleties worth getting right once:
 *
 *  - the *committed* search term is debounced separately from the input, so
 *    typing does not fire a request per keystroke;
 *  - `keepPreviousData` holds the current page on screen while the next one
 *    loads, which stops the table flashing empty on every page change.
 *
 * The caller supplies a `fetcher` rather than a URL. The previous version took a
 * REST `path`, which cannot express a Supabase query with joins and RLS-driven
 * filters; now each page owns its own query and this hook only owns paging,
 * search and filter state.
 */

export type FilterValue = string | number | boolean | undefined | null;
export type Filters = Record<string, FilterValue>;

export interface ListParams {
  page: number;
  pageSize: number;
  [key: string]: FilterValue;
}

export type { ListResponse };

export interface UseListQueryOptions<T> {
  /** Query-key segment, e.g. `['students']`. */
  key: unknown[];
  /**
   * Runs the query. Receives the merged params (filters + page + pageSize +
   * debounced `search`) and must resolve to a `ListResponse`.
   *
   * Must be stable — wrap in `useCallback` or define outside the component.
   */
  fetcher: (params: ListParams) => Promise<ListResponse<T>>;
  /** Filters applied on first render; the caller can change them afterwards. */
  initialFilters?: Filters;
  enabled?: boolean;
  /** Keeps the previous page visible while the next loads. */
  keepPreviousPage?: boolean;
}

const SEARCH_DEBOUNCE_MS = 350;

export function useListQuery<T>({
  key,
  fetcher,
  initialFilters = {},
  enabled = true,
  keepPreviousPage = true,
}: UseListQueryOptions<T>) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Filters>(initialFilters);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const params = useMemo<ListParams>(
    () => ({
      ...filters,
      page,
      pageSize,
      ...(search ? { search } : {}),
    }),
    [filters, page, pageSize, search],
  );

  const query = useQuery({
    queryKey: [...key, params],
    queryFn: () => fetcher(params),
    enabled,
    placeholderData: keepPreviousPage ? keepPreviousData : undefined,
    staleTime: 15_000,
  });

  /**
   * Merge a filter change. Resetting to page 1 matters: staying on page 7 after
   * narrowing a filter shows an empty page and looks like data loss.
   */
  const setFilter = useCallback((name: string, value: FilterValue) => {
    setFilters((current) => {
      const next = { ...current };
      if (value === undefined || value === null || value === '') delete next[name];
      else next[name] = value;
      return next;
    });
    setPage(1);
  }, []);

  /** Apply several filters at once, e.g. a "clear all" button. */
  const resetFilters = useCallback(() => {
    setFilters({});
    setSearchInput('');
    setSearch('');
    setPage(1);
  }, []);

  const isFiltered = search !== '' || Object.keys(filters).length > 0;

  return {
    ...query,
    items: query.data?.items ?? [],
    total: query.data?.total ?? 0,
    page,
    setPage,
    pageSize,
    setPageSize,
    searchInput,
    setSearchInput,
    filters,
    setFilter,
    resetFilters,
    isFiltered,
    /** True only on a settled, genuinely empty result. */
    isEmpty: query.isSuccess && !query.isPlaceholderData && (query.data?.items.length ?? 0) === 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                   */
/* -------------------------------------------------------------------------- */

export interface UseResourceMutationOptions<TData, TVars> {
  mutationFn: (variables: TVars) => Promise<TData>;
  /** Query keys to invalidate on success. */
  invalidates?: unknown[][];
  onSuccess?: (data: TData) => void;
}

/**
 * CRUD mutation wrapper.
 *
 * `QueryError.userMessage` is always safe to render, so callers never need to
 * branch on status codes to decide what the user should read.
 *
 * `mutationFn` is required. The previous version of this hook accepted no way to
 * supply one, which meant all nine mutations across the admin screens silently
 * resolved without ever issuing a request — a bug that typechecking could not
 * catch and that no test exercised.
 */
export function useResourceMutation<TData, TVars = void>(
  options: UseResourceMutationOptions<TData, TVars>,
) {
  const queryClient = useQueryClient();
  const { invalidates = [], onSuccess, mutationFn } = options;

  return useMutation<TData, QueryError, TVars>({
    mutationFn,
    onSuccess: (data) => {
      for (const target of invalidates) {
        void queryClient.invalidateQueries({ queryKey: target });
      }
      onSuccess?.(data);
    },
  });
}

/**
 * Wraps a promise so a component can show a spinner without duplicating
 * `useState` + try/finally at every call site.
 */
export function useAsyncAction<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (...args: TArgs): Promise<TResult | undefined> => {
      setPending(true);
      setError(null);
      try {
        return await action(...args);
      } catch (caught) {
        setError(
          caught instanceof QueryError ? caught.userMessage : 'Something went wrong.',
        );
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [action],
  );

  return { run, pending, error, setError };
}