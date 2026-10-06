import { QueryClient } from '@tanstack/react-query';
import { QueryError } from './query';

/**
 * TanStack Query defaults.
 *
 * Three deliberate choices:
 *
 * 1. `retry` never fires on a 4xx. Retrying a 403 or a validation error just
 *    delays the message the user needs, and — for permission failures — burns
 *    requests that will fail identically every time.
 * 2. `refetchOnWindowFocus` is on for data that changes as others work (review
 *    queues, submission status): it keeps a teacher's screen honest without
 *    polling.
 * 3. Mutations never retry. They are user-initiated, so a retried save could
 *    duplicate an action the user already believes succeeded.
 *
 * The previous version branched on `ApiError.status`. It now branches on
 * `QueryError.code`, which is a Postgres SQLSTATE rather than an HTTP status —
 * PostgREST reports a refused RLS policy as `42501` with HTTP 200, so the old
 * status check would have retried a denial that could never succeed.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: (failureCount, error) => {
        if (error instanceof QueryError) {
          // Postgres SQLSTATEs that mean "this will never work":
          //   42501 permission denied / RLS refused
          //   23503 foreign key violation
          //   23505 unique violation
          //   23514 check constraint violated
          //   22003 numeric out of range
          //   PGRST116 no rows returned
          if (['42501', '23503', '23505', '23514', '22003', 'PGRST116', 'P0002'].includes(error.code)) {
            return false;
          }

          // A domain refusal from a workflow RPC — SUBMISSION_NOT_EDITABLE,
          // FORBIDDEN, CONFLICT. Retrying would just re-report it.
          if (['FORBIDDEN', 'CONFLICT', 'SUBMISSION_NOT_EDITABLE', 'SUBMISSION_LOCKED'].includes(error.code)) {
            return false;
          }
        }

        return failureCount < 2;
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      refetchOnWindowFocus: true,
    },
    mutations: {
      retry: false,
    },
  },
});