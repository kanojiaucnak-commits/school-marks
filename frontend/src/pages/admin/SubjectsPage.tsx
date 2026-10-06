import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { PERMISSIONS, type Subject } from '@school/shared';
import { useAuth } from '../../lib/auth';
import { QueryError } from '../../lib/query';
import { can } from '../../lib/permissions';
import {
  createSubject,
  deactivateSubject,
  listSubjects,
  updateSubject,
} from '../../lib/repos/academic';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { TextInput } from '../../components/ui/Field';
import { Card } from '../../components/ui/Table';
import { Alert, EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { Modal } from '../../components/ui/Modal';
import { useCrudMutation } from '../../components/admin/useCrudMutation';
import { IconPlus } from '../../components/ui/icons';

/**
 * Subjects.
 *
 * Subjects are school-wide rather than per-year, so one subject record serves
 * every class. A subject that already has marks is archived (deactivated)
 * instead of deleted so historical reports keep resolving its name.
 */
export default function SubjectsPage() {
  const { user } = useAuth();
  const [editing, setEditing] = useState<Subject | null>(null);
  const [creating, setCreating] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['subjects'],
    queryFn: () => listSubjects(),
  });

  const create = useCrudMutation<Subject, { code: string; name: string; description?: string }>({
    mutationFn: (values) =>
      createSubject({
        code: values.code,
        name: values.name,
        description: values.description,
      }),
    invalidates: [['subjects']],
    successMessage: 'Subject created',
    onSuccess: () => setCreating(false),
  });

  const update = useCrudMutation<Subject, { id: string; name: string }>({
    mutationFn: ({ id, name }) => updateSubject(id, { name }),
    invalidates: [['subjects']],
    successMessage: 'Subject updated',
    onSuccess: () => setEditing(null),
  });

  const remove = useCrudMutation<void, string>({
    mutationFn: (id) => deactivateSubject(id),
    invalidates: [['subjects']],
    successMessage: 'Subject removed',
  });

  const submitInnerForm = () => {
    (document.getElementById('subject-form') as HTMLFormElement | null)?.requestSubmit();
  };

  const subjects = data ?? [];
  const canManage = can(user, PERMISSIONS.SUBJECT_MANAGE);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">
            Available to every class. The code appears on reports and exports.
          </h1>
        </div>
        {canManage && (
          <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setCreating(true)}>
            Add subject
          </Button>
        )}
      </header>

      <Card flush>
        {isLoading && <LoadingState label="Loading subjects…" />}
        {error instanceof QueryError && (
          <div className="p-5">
            <ErrorState message={error.userMessage} onRetry={() => void refetch()} />
          </div>
        )}
        {!isLoading && subjects.length === 0 && (
          <div className="p-5">
            <EmptyState title="No subjects yet" description="Add your first subject to begin." icon="📚" />
          </div>
        )}

        {subjects.length > 0 && (
          <ul className="divide-y divide-line-soft">
            {subjects.map((subject) => (
              <li key={subject.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <Badge tone="accent">{subject.code}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink">{subject.name}</p>
                  {subject.description && (
                    <p className="truncate text-xs text-ink-subtle">{subject.description}</p>
                  )}
                </div>

                {canManage && (
                  <div className="flex gap-1.5">
                    <Button size="sm" onClick={() => setEditing(subject)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={remove.isPending}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Remove "${subject.name}"? If it already has marks it will be archived instead of deleted.`,
                          )
                        ) {
                          remove.mutate(subject.id);
                        }
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Create */}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Add a subject"
        description="Give it a short uppercase code and a full name."
        busy={create.isPending}
        footer={
          <>
            <Button onClick={() => setCreating(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={create.isPending} onClick={submitInnerForm}>
              Create subject
            </Button>
          </>
        }
      >
        <SubjectForm
          formId="subject-form"
          error={create.fieldError}
          pending={create.isPending}
          onSubmit={(values) => create.mutate(values)}
        />
      </Modal>

      {/* Edit */}
      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={`Edit ${editing?.name ?? ''}`}
        busy={update.isPending}
        footer={
          <>
            <Button onClick={() => setEditing(null)} disabled={update.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={update.isPending}
              onClick={() => editing && update.mutate({ id: editing.id, name: editing.name })}
              disabled={!editing}
            >
              Save
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-4">
            {update.fieldError && <Alert tone="danger">{update.fieldError}</Alert>}
            <TextInput label="Code" defaultValue={editing.code} readOnly hint="The code cannot be changed." />
            <TextInput
              label="Name"
              defaultValue={editing.name}
              id="edit-subject-name"
              onChange={(event) => setEditing({ ...editing, name: event.target.value })}
            />
            <p className="text-xs text-ink-subtle">
              Press Save to apply. Only the name can be changed here.
            </p>
            <Button
              className="sr-only"
              onClick={() => update.mutate({ id: editing.id, name: editing.name })}
            >
              Save
            </Button>
          </div>
        )}
      </Modal>

      {subjects.length > 0 && (
        <Alert tone="info" title="Archiving rather than deleting">
          A subject with recorded marks cannot be deleted — the historical reports would lose their
          name. Removing one archives it instead, so it disappears from selectors but stays intact
          in past reports.
        </Alert>
      )}

    </div>
  );
}

/* -------------------------------------------------------------------------- */

function SubjectForm({
  formId,
  onSubmit,
  error,
  pending,
}: {
  formId: string;
  onSubmit: (values: { code: string; name: string; description?: string }) => void;
  error: string | null;
  pending: boolean;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<{ code: string; name: string; description?: string }>({
    defaultValues: { code: '', name: '', description: '' },
  });

  return (
    <form
      id={formId}
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit(onSubmit)();
      }}
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <TextInput
        label="Code"
        placeholder="MATH"
        hint="Short and unique, shown on reports. Letters, numbers and hyphens."
        error={errors.code?.message}
        {...register('code', { required: 'Enter a code' })}
      />

      <TextInput
        label="Name"
        placeholder="Mathematics"
        error={errors.name?.message}
        {...register('name', { required: 'Enter a name' })}
      />

      <TextInput
        label="Description (optional)"
        {...register('description')}
      />

      {pending && <p className="sr-only">Saving…</p>}
    </form>
  );
}
