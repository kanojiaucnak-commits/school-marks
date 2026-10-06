import { useCallback, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  createAcademicYearSchema,
  type AcademicYear,
  type CreateAcademicYearInput,
} from '@school/shared';
import { QueryError, type ListResponse } from '../../lib/query';
import {
  archiveAcademicYear,
  createAcademicYear,
  listAcademicYears,
  setCurrentAcademicYear,
} from '../../lib/repos/academic';
import { formatDate } from '../../lib/utils';
import { Badge, ToneBadge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Checkbox, TextInput } from '../../components/ui/Field';
import { Card, Pagination, Table, TBody, TD, TH, THead, TR } from '../../components/ui/Table';
import { Alert, EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { ConfirmDialog, Modal } from '../../components/ui/Modal';
import { useListQuery, type ListParams } from '../../hooks/useListQuery';
import { useCrudMutation } from '../../components/admin/useCrudMutation';
import { IconPlus } from '../../components/ui/icons';

/** Academic years. Years are archived rather than deleted — marks reference them. */
export default function AcademicYearsPage() {
  /** Submits the form rendered inside the dialog so Zod validation runs first. */
  const submitInnerForm = () => {
    (document.getElementById('academic-year-form') as HTMLFormElement | null)?.requestSubmit();
  };

  const [createOpen, setCreateOpen] = useState(false);
  const [archiving, setArchiving] = useState<AcademicYear | null>(null);

  /**
   * A school has a handful of years, so the whole set is one query and the
   * hook's paged envelope is filled in one shot rather than sliced in the
   * browser. `includeArchived` arrives through the filters so the hook still
   * owns the query key and any later reset behaviour.
   */
  const fetcher = useCallback(
    async (params: ListParams): Promise<ListResponse<AcademicYear>> => {
      const items = await listAcademicYears(params.includeArchived === true);
      const page = Math.max(1, Number(params.page) || 1);
      const pageSize = Math.max(1, Number(params.pageSize) || 25);
      return {
        items,
        page,
        pageSize,
        total: items.length,
        totalPages: 1,
      };
    },
    [],
  );

  const list = useListQuery<AcademicYear>({
    // The `pair` suffix keeps this paged envelope off the same cache key the
    // year *selectors* use. Both still start with `'academic-years'`, so the
    // prefix invalidation below still refreshes every selector in the app.
    key: ['academic-years', 'paged'],
    fetcher,
    initialFilters: { includeArchived: true },
  });

  const create = useCrudMutation<AcademicYear, CreateAcademicYearInput>({
    mutationFn: (values) =>
      createAcademicYear({
        name: values.name,
        startDate: values.startDate,
        endDate: values.endDate,
        isCurrent: values.isCurrent,
      }),
    invalidates: [['academic-years']],
    successMessage: 'Academic year created',
    onSuccess: () => setCreateOpen(false),
  });

  const archive = useCrudMutation<void, string>({
    mutationFn: (id) => archiveAcademicYear(id),
    invalidates: [['academic-years']],
    successMessage: 'Academic year archived',
    onSuccess: () => setArchiving(null),
  });

  const setCurrent = useCrudMutation<void, string>({
    mutationFn: (id) => setCurrentAcademicYear(id),
    invalidates: [['academic-years']],
    successMessage: 'Set as the current academic year',
  });

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">
            Years are archived rather than deleted so past marks and reports stay intact.
          </h1>
        </div>
        <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setCreateOpen(true)}>
          Add academic year
        </Button>
      </header>

      <Card flush>
        {list.isLoading && <LoadingState label="Loading academic years…" />}
        {list.error instanceof QueryError && (
          <div className="p-5">
            <ErrorState message={list.error.userMessage} onRetry={() => void list.refetch()} />
          </div>
        )}
        {list.isEmpty && (
          <div className="p-5">
            <EmptyState
              title="No academic years yet"
              description="Create one before adding classes, sections or students."
              icon="📅"
            />
          </div>
        )}

        {list.items.length > 0 && (
          <Table caption="Academic years">
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Starts</TH>
                <TH>Ends</TH>
                <TH>Current</TH>
                <TH>Status</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </tr>
            </THead>
            <TBody>
              {list.items.map((year) => (
                <TR key={year.id}>
                  <TD className="font-medium text-ink">{year.name}</TD>
                  <TD className="tabular text-ink-muted">{formatDate(year.startDate)}</TD>
                  <TD className="tabular text-ink-muted">{formatDate(year.endDate)}</TD>
                  <TD>
                    {year.isCurrent ? <ToneBadge tone="success">Current</ToneBadge> : null}
                  </TD>
                  <TD>
                    <Badge tone={year.status === 'active' ? 'info' : 'neutral'}>{year.status}</Badge>
                  </TD>
                  <TD>
                    <div className="flex justify-end gap-1.5">
                      {!year.isCurrent && year.status === 'active' && (
                        <Button
                          size="sm"
                          loading={setCurrent.isPending}
                          onClick={() => setCurrent.mutate(year.id)}
                        >
                          Make current
                        </Button>
                      )}
                      {year.status === 'active' && (
                        <Button size="sm" variant="ghost" onClick={() => setArchiving(year)}>
                          Archive
                        </Button>
                      )}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {/* Create */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Add an academic year"
        busy={create.isPending}
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={create.isPending}
              onClick={submitInnerForm}
            >
              Create
            </Button>
          </>
        }
      >
        <AcademicYearForm
          pending={create.isPending}
          error={create.fieldError}
          onSubmit={(values) => create.mutate(values)}
        />
      </Modal>

      <ConfirmDialog
        open={Boolean(archiving)}
        onCancel={() => setArchiving(null)}
        onConfirm={() => archiving && archive.mutate(archiving.id)}
        busy={archive.isPending}
        tone="danger"
        title={`Archive ${archiving?.name}?`}
        confirmLabel="Archive"
        message="Students, exams and marks in this year keep their records and reports. The year simply stops appearing in new-entry selectors."
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function AcademicYearForm({
  onSubmit,
  error,
  pending,
}: {
  onSubmit: (values: CreateAcademicYearInput) => void;
  error: string | null;
  pending: boolean;
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateAcademicYearInput>({
    resolver: zodResolver(createAcademicYearSchema),
    defaultValues: {
      name: '',
      startDate: '',
      endDate: '',
      isCurrent: false,
      status: 'active',
    },
  });

  return (
    <form
      id="academic-year-form"
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit(onSubmit)();
      }}
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <TextInput
        label="Name"
        placeholder="2026-2027"
        hint="How the year appears in every selector."
        error={errors.name?.message}
        {...register('name')}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput
          label="Start date"
          type="date"
          error={errors.startDate?.message}
          {...register('startDate')}
        />
        <TextInput
          label="End date"
          type="date"
          error={errors.endDate?.message}
          {...register('endDate')}
        />
      </div>

      <Checkbox
        label="Set as the current academic year"
        description="Only one year can be current. This becomes the default in new-entry screens."
        {...register('isCurrent')}
      />
      {pending && <p className="sr-only">Saving…</p>}
    </form>
  );
}
