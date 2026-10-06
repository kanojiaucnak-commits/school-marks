import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { QueryError } from '../../lib/query';
import { useToast } from '../ui/Toast';

/**
 * One mutation helper for the admin CRUD screens.
 *
 * It does four things every one of them needs and none should re-implement:
 * surface a safe user-facing error message, invalidate the affected query keys,
 * toast on success, and keep the error in local state so a form can also show it
 * inline.
 *
 * `mutationFn` is **required**. It used to be absent from the options type, which
 * is why all nine mutations in `TeachersPage`, `AcademicYearsPage` and
 * `SubjectsPage` were wired up but inert — `mutate()` ran an empty function,
 * fired a success toast, and never touched the server. Requiring it turns that
 * class of bug into a compile error.
 */
export function useCrudMutation<TResponse, TVariables>(options: {
  /** The actual write. Required. */
  mutationFn: (variables: TVariables) => Promise<TResponse>;
  /** Query keys to refresh after a successful mutation. */
  invalidates?: unknown[][];
  successMessage?: string;
  onSuccess?: (data: TResponse) => void;
}) {
  const queryClient = useQueryClient();
  const { success, error } = useToast();
  const [fieldError, setFieldError] = useState<string | null>(null);

  const { invalidates = [], successMessage, onSuccess, mutationFn } = options;

  const mutation = useMutation<TResponse, QueryError, TVariables>({
    mutationFn,
    onSuccess: (data) => {
      for (const target of invalidates) {
        void queryClient.invalidateQueries({ queryKey: target });
      }
      if (successMessage) success(successMessage);
      setFieldError(null);
      onSuccess?.(data);
    },
    onError: (caught) => {
      const message = caught.userMessage;
      setFieldError(message);
      error(message);
    },
  });

  return {
    ...mutation,
    fieldError,
    clearFieldError: () => setFieldError(null),
  };
}