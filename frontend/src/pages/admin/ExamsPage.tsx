import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Exam } from '@school/shared';
import { QueryError } from '../../lib/query';
import {
  createExam,
  deleteExam,
  listExams,
  updateExam,
} from '../../lib/repos/academic';
import { formatDate } from '../../lib/utils';
import { ToneBadge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Select, TextInput } from '../../components/ui/Field';
import { Card, CardHeader, Table, TBody, TD, TH, THead, TR } from '../../components/ui/Table';
import { Alert, EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { Modal } from '../../components/ui/Modal';
import { useCrudMutation } from '../../components/admin/useCrudMutation';
import { useAcademicYears } from '../../hooks/useAcademicYears';
import { IconEdit, IconPlus, IconTrash } from '../../components/ui/icons';

/** Shared by the create and edit forms so the two cannot drift apart. */
export interface ExamFormValues {
  academicYearId: string;
  name: string;
  maxMarks: number;
  weightage: number;
  examDate: string | null;
  status: Exam['status'];
}

/**
 * Exams.
 *
 * The maximum marks set here is the single source of truth every mark is
 * validated against, so lowering it once marks exist is refused by the database
 * rather than silently invalidating records.
 */
export default function ExamsPage() {
  const queryClient = useQueryClient();

  const [academicYearId, setAcademicYearId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Exam | null>(null);
  const [deleting, setDeleting] = useState<Exam | null>(null);

  const { data: yearsData } = useAcademicYears();

  useEffect(() => {
    if (!academicYearId && yearsData?.current) setAcademicYearId(yearsData.current.id);
  }, [yearsData, academicYearId]);

  const { data: exams, isLoading, error, refetch } = useQuery({
    queryKey: ['exams', academicYearId],
    // The repo takes a year rather than an optional one, so the query waits for
    // the auto-selected year instead of firing with an empty id.
    queryFn: () => listExams(academicYearId),
    enabled: Boolean(academicYearId),
  });

  const create = useCrudMutation<Exam, ExamFormValues>({
    mutationFn: (values) => createExam(values),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['exams'] });
      setCreateOpen(false);
    },
    successMessage: 'Exam created',
  });

  /**
   * Edit and delete.
   *
   * `updateExam` and `deleteExam` existed in the repository with no way to reach
   * them, so an exam could be created but never corrected — and an exam created by
   * mistake could only be left in place.
   *
   * Lowering the maximum is the dangerous direction and the database refuses it once
   * marks exist, which surfaces here as a field error rather than a silent failure.
   */
  const update = useCrudMutation<Exam, ExamFormValues & { id: string }>({
    mutationFn: ({ id, ...values }) => updateExam(id, values),
    invalidates: [['exams']],
    successMessage: 'Exam updated',
    onSuccess: () => setEditing(null),
  });

  const remove = useCrudMutation<void, string>({
    mutationFn: (id) => deleteExam(id),
    invalidates: [['exams']],
    successMessage: 'Exam deleted',
    onSuccess: () => setDeleting(null),
  });

  const examList = exams ?? [];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">
            The maximum marks set here is the ceiling every mark is validated against.
          </h1>
        </div>
        <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setCreateOpen(true)}>
          Add exam
        </Button>
      </header>

      <Card className="p-4">
        <Select
          label="Academic year"
          value={academicYearId}
          onChange={(event) => setAcademicYearId(event.target.value)}
          options={(yearsData?.academicYears ?? []).map((year) => ({ value: year.id, label: year.name }))}
          placeholder="All years"
        />
      </Card>

      <Card flush>
        {isLoading && <LoadingState label="Loading exams…" />}
        {error instanceof QueryError && (
          <div className="p-5">
            <ErrorState message={error.userMessage} onRetry={() => void refetch()} />
          </div>
        )}
        {!isLoading && examList.length === 0 && (
          <div className="p-5">
            <EmptyState title="No exams yet" description="Create an exam so teachers can enter marks." icon="📝" />
          </div>
        )}

        {examList.length > 0 && (
          <Table caption="Exams">
            <THead>
              <tr>
                <TH>Name</TH>
                <TH numeric>Max marks</TH>
                <TH numeric>Weightage</TH>
                <TH>Date</TH>
                <TH>Status</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </tr>
            </THead>
            <TBody>
              {examList.map((exam) => (
                <TR key={exam.id}>
                  <TD className="font-medium text-ink">{exam.name}</TD>
                  <TD numeric className="tabular text-ink">{exam.maxMarks}</TD>
                  <TD numeric className="tabular text-ink-muted">{exam.weightage}</TD>
                  <TD className="tabular text-ink-muted">{formatDate(exam.examDate)}</TD>
                  <TD>
                    <ToneBadge
                      tone={
                        exam.status === 'completed'
                          ? 'success'
                          : exam.status === 'cancelled'
                            ? 'danger'
                            : exam.status === 'ongoing'
                              ? 'warning'
                              : 'neutral'
                      }
                    >
                      {exam.status}
                    </ToneBadge>
                  </TD>
                  <TD className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" onClick={() => setEditing(exam)} aria-label={`Edit ${exam.name}`}>
                        <IconEdit size={16} />
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => setDeleting(exam)}
                        aria-label={`Delete ${exam.name}`}
                      >
                        <IconTrash size={16} />
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Add an exam"
        busy={create.isPending}
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={create.isPending}
              onClick={() =>
                (document.getElementById('exam-form') as HTMLFormElement | null)?.requestSubmit()
              }
            >
              Create exam
            </Button>
          </>
        }
      >
        <ExamForm
          academicYearId={academicYearId}
          error={create.fieldError}
          onSubmit={(values) => create.mutate(values)}
        />
      </Modal>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={`Edit ${editing?.name ?? 'exam'}`}
        busy={update.isPending}
        footer={
          <>
            <Button onClick={() => setEditing(null)} disabled={update.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={update.isPending}
              onClick={() =>
                (document.getElementById('exam-edit-form') as HTMLFormElement | null)?.requestSubmit()
              }
            >
              Save changes
            </Button>
          </>
        }
      >
        {editing && (
          <ExamForm
            id="exam-edit-form"
            academicYearId={editing.academicYearId}
            initial={editing}
            error={update.fieldError}
            onSubmit={(values) => update.mutate({ id: editing.id, ...values })}
          />
        )}
      </Modal>

      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.name ?? 'exam'}?`}
        busy={remove.isPending}
        footer={
          <>
            <Button onClick={() => setDeleting(null)} disabled={remove.isPending}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.id)}
            >
              Delete exam
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Alert tone="danger" title="This cannot be undone">
            Deleting an exam removes its mark sheets and every mark recorded against it. If the exam
            simply should not be used, cancelling it is safer.
          </Alert>
          {remove.fieldError && <Alert tone="danger">{remove.fieldError}</Alert>}
          <p className="text-sm text-ink-muted">
            If any marks exist, the database refuses the delete and the exam is kept — you will see the
            reason here rather than losing the record silently.
          </p>
        </div>
      </Modal>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Create and edit form for an exam.
 *
 * One component serves both so the two cannot drift apart — the create form used
 * to hard-code `status: 'scheduled'`, which meant an edit would have silently reset
 * a completed or cancelled exam. When editing, `initial` supplies the current
 * values and the status selector is shown so it can be preserved or changed.
 */
function ExamForm({
  academicYearId,
  initial,
  onSubmit,
  error,
  id = 'exam-form',
}: {
  academicYearId: string;
  /** Present when editing; seeds the fields and reveals the status control. */
  initial?: Exam;
  onSubmit: (values: ExamFormValues) => void;
  error: string | null;
  id?: string;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [maxMarks, setMaxMarks] = useState(String(initial?.maxMarks ?? 100));
  const [examDate, setExamDate] = useState(initial?.examDate?.slice(0, 10) ?? '');
  const [weightage, setWeightage] = useState(String(initial?.weightage ?? 1));
  const [status, setStatus] = useState<Exam['status']>(initial?.status ?? 'scheduled');

  const numericMax = Number(maxMarks);
  const maxValid = Number.isFinite(numericMax) && numericMax > 0;
  const editing = Boolean(initial);

  return (
    <form
      id={id}
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!maxValid || !academicYearId || !name.trim()) return;
        onSubmit({
          academicYearId,
          name: name.trim(),
          maxMarks: numericMax,
          weightage: Number(weightage) || 1,
          examDate: examDate || null,
          status: editing ? status : 'scheduled',
        });
      }}
    >
      {error && <Alert tone="danger">{error}</Alert>}

      {!academicYearId && <Alert tone="warning">Choose an academic year first.</Alert>}

      <TextInput
        label="Exam name"
        placeholder="Term 1"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput
          label="Maximum marks"
          type="number"
          min={1}
          step="any"
          value={maxMarks}
          onChange={(event) => setMaxMarks(event.target.value)}
          hint="No mark can exceed this."
          error={maxMarks !== '' && !maxValid ? 'Must be greater than zero' : null}
          required
        />
        <TextInput
          label="Weightage"
          type="number"
          min={0.1}
          step="any"
          value={weightage}
          onChange={(event) => setWeightage(event.target.value)}
          hint="Used when combining subjects into an overall result."
        />
      </div>

      <TextInput
        label="Exam date (optional)"
        type="date"
        value={examDate}
        onChange={(event) => setExamDate(event.target.value)}
      />

      {editing && (
        <Select
          label="Status"
          value={status}
          onChange={(event) => setStatus(event.target.value as Exam['status'])}
          options={[
            { value: 'scheduled', label: 'Scheduled' },
            { value: 'ongoing', label: 'Ongoing' },
            { value: 'completed', label: 'Completed' },
            { value: 'cancelled', label: 'Cancelled' },
          ]}
          hint="Cancelling keeps the exam and its marks, but stops it being used for new submissions."
        />
      )}

      <Alert tone="info">
        This maximum becomes a hard ceiling: a mark of 101 against a maximum of 100 is rejected by
        the server, not just hidden in the interface.
      </Alert>
    </form>
  );
}
