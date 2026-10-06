import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QueryError } from '../lib/query';
import {
  cancelAssignmentRequest,
  listAssignmentRequests,
  listClassSections,
  listSubjects,
  requestAssignment,
  type AssignmentRequest,
} from '../lib/repos/academic';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Select } from '../components/ui/Field';
import { Card, Table, TBody, TD, TH, THead, TR } from '../components/ui/Table';
import { Alert, EmptyState, ErrorState, LoadingState } from '../components/ui/States';
import { useCrudMutation } from '../components/admin/useCrudMutation';
import { useAcademicYears } from '../hooks/useAcademicYears';
import { useCurrentUser } from '../lib/auth';
/**
 * A teacher's own classes — the self-service half of assignment management.
 *
 * Teachers sign themselves up, so somebody has to hand out the classes they may
 * teach. This screen is the request; the admin `ClassRequestsPage` is the
 * approval. Approval writes a real `teacher_assignments` row, which is the same
 * thing `AssignmentsPage` creates by hand, so both routes converge on one
 * mechanism and RLS keeps reading exactly one thing.
 *
 * Until a request is approved a teacher can see the class/subject directory and
 * nothing else: `students_read` and `can_read_sheet` are both scoped to an
 * existing assignment. That is enforced in Postgres, not by hiding buttons here.
 */
const STATUS_TONE = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
} as const;
const STATUS_LABEL = {
  pending: '⏳ Waiting for approval',
  approved: '✓ Approved',
  rejected: '✕ Declined',
  cancelled: '– Withdrawn',
} as const;
export default function MyClassesPage() {
  const me = useCurrentUser();
  const queryClient = useQueryClient();
  const [academicYearId, setAcademicYearId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const { data: yearsData } = useAcademicYears();
  useEffect(() => {
    if (!academicYearId && yearsData?.current) setAcademicYearId(yearsData.current.id);
  }, [yearsData, academicYearId]);
  const { data: classSections } = useQuery({
    queryKey: ['class-sections', academicYearId],
    queryFn: () => listClassSections(academicYearId),
    enabled: Boolean(academicYearId),
    staleTime: 5 * 60_000,
  });
  const { data: subjects } = useQuery({
    queryKey: ['subjects'],
    queryFn: () => listSubjects(),
    staleTime: 10 * 60_000,
  });
  const { data: requests, isLoading, error, refetch } = useQuery({
    queryKey: ['assignment-requests', me.id],
    queryFn: () => listAssignmentRequests(),
  });
  const ask = useCrudMutation<AssignmentRequest, {
    academicYearId: string;
    sectionId: string;
    subjectId: string;
    classId: string;
  }>({
    mutationFn: (values) =>
      requestAssignment({
        academicYearId: values.academicYearId,
        classId: values.classId,
        sectionId: values.sectionId,
        subjectId: values.subjectId,
      }),
    invalidates: [['assignment-requests'], ['assignments']],
    successMessage: 'Request sent',
    onSuccess: () => {
      setSectionId('');
      setSubjectId('');
    },
  });
  const withdraw = useCrudMutation<AssignmentRequest, string>({
    mutationFn: (id) => cancelAssignmentRequest(id),
    invalidates: [['assignment-requests']],
    successMessage: 'Request withdrawn',
  });
  const sections = classSections ?? [];
  const selectedClassId = sections.find((entry) => entry.sectionId === sectionId)?.classId;
  const canAsk = Boolean(academicYearId && sectionId && subjectId && selectedClassId);
  // Offering a combination that already has a live request would only earn the
  // user an error from `request_assignment`, so filter those out of the dropdown
  // rather than letting them pick and fail.
  const openKeys = useMemo(
    () =>
      new Set(
        (requests ?? [])
          .filter((entry) => entry.status === 'pending' || entry.status === 'approved')
          .map((entry) => `${entry.sectionId}:${entry.subjectId}`),
      ),
    [requests],
  );
  const availableSubjects = (subjects ?? []).filter(
    (subject) => !openKeys.has(`${sectionId}:${subject.id}`),
  );
  return (
    <div className="space-y-5">
      <header>
        <h1 className="page-title">
          Request the class, section and subject you teach. You can enter marks once an
          administrator approves.
        </h1>
      </header>
      <Alert tone="info" title="What you can see before approval">
        You can browse the class and subject directory to make a request. Student records and
        mark sheets stay hidden until a request is approved — the server checks your assignments
        on every request, not just here.
      </Alert>
      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Select
            label="Academic year"
            value={academicYearId}
            onChange={(event) => setAcademicYearId(event.target.value)}
            options={(yearsData?.academicYears ?? []).map((year) => ({
              value: year.id,
              label: year.name,
            }))}
            placeholder="Select a year"
          />
          <Select
            label="Class and section"
            value={sectionId}
            onChange={(event) => {
              setSectionId(event.target.value);
              setSubjectId('');
            }}
            options={[
              { value: '', label: 'Select a section' },
              ...sections.map((entry) => ({
                value: entry.sectionId,
                label: `${entry.className ?? '—'} · ${entry.sectionName ?? '—'}`,
              })),
            ]}
            disabled={!academicYearId}
          />
          <Select
            label="Subject"
            value={subjectId}
            onChange={(event) => setSubjectId(event.target.value)}
            options={[
              { value: '', label: sectionId ? 'Select a subject' : 'Choose a section first' },
              ...availableSubjects.map((subject) => ({ value: subject.id, label: subject.name })),
            ]}
            disabled={!sectionId}
          />
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            disabled={!canAsk}
            onClick={() => {
              if (!canAsk || !selectedClassId) return;
              ask.mutate({ academicYearId, sectionId, subjectId, classId: selectedClassId });
            }}
          >
            Request this class
          </Button>
        </div>
      </Card>
      <Card flush>
        {isLoading && <LoadingState label="Loading your requests…" />}
        {error instanceof QueryError && (
          <div className="p-5">
            <ErrorState message={error.userMessage} onRetry={() => void refetch()} />
          </div>
        )}
        {!isLoading && (requests ?? []).length === 0 && (
          <div className="p-5">
            <EmptyState
              title="No requests yet"
              description="Pick a class, section and subject above to ask an administrator for access."
              icon="🧭"
            />
          </div>
        )}
        {(requests ?? []).length > 0 && (
          <Table caption="Your class requests">
            <THead>
              <tr>
                <TH>Class</TH>
                <TH>Subject</TH>
                <TH>Year</TH>
                <TH>Status</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </tr>
            </THead>
            <TBody>
              {(requests ?? []).map((entry) => (
                <TR key={entry.id}>
                  <TD>
                    {entry.className ?? '—'} · {entry.sectionName ?? '—'}
                  </TD>
                  <TD>{entry.subjectName ?? '—'}</TD>
                  <TD>{entry.academicYearName ?? '—'}</TD>
                  <TD>
                    <Badge tone={STATUS_TONE[entry.status]}>{STATUS_LABEL[entry.status]}</Badge>
                    {entry.status === 'rejected' && entry.note && (
                      <p className="mt-1 text-xs text-ink-muted">{entry.note}</p>
                    )}
                  </TD>
                  <TD className="text-right">
                    {entry.status === 'pending' && (
                      <Button variant="ghost" onClick={() => withdraw.mutate(entry.id)}>
                        Withdraw
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
