import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PERMISSIONS, type Student } from '@school/shared';
import { useAuth } from '../../lib/auth';
import { QueryError, camelMany, toQueryError } from '../../lib/query';
import { can } from '../../lib/permissions';
import { getSupabase } from '../../lib/supabase';
import { getStudent, getStudentHistory, type StudentHistoryRow } from '../../lib/repos/students';
import { formatDate, formatPercent } from '../../lib/utils';
import { Badge, ToneBadge } from '../../components/ui/Badge';
import { Button, LinkButton } from '../../components/ui/Button';
import { Card, CardHeader, Table, TBody, TD, TH, THead, TR } from '../../components/ui/Table';
import { Alert, EmptyState, ErrorState, LoadingState } from '../../components/ui/States';

/**
 * Student record.
 *
 * Shows the current year plus every previous year, which is how year-on-year
 * comparison works: each academic year has its own immutable row, so promoting a
 * student never rewrites the past.
 */
export default function StudentDetailPage() {
  const { studentId = '' } = useParams<{ studentId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const { data: record, isLoading, error, refetch } = useQuery({
    queryKey: ['students', studentId],
    enabled: Boolean(studentId),
    queryFn: async (): Promise<Student> => {
      const student = await getStudent(studentId);
      if (!student) {
        throw new QueryError('PGRST116', 'That record could not be found.');
      }
      return student;
    },
  });

  const { data: history } = useQuery({
    queryKey: ['students', studentId, 'history'],
    enabled: Boolean(studentId),
    queryFn: () => getStudentHistory(studentId),
  });

  /**
   * `getStudentHistory` aggregates marks per year but does not carry each row's
   * status, so the Status column is filled from a page-local read of the same
   * rows. A repo that returned `status` would make this redundant.
   */
  const historyIds = useMemo(() => (history ?? []).map((row) => row.id), [history]);

  const { data: historyStatuses } = useQuery({
    queryKey: ['students', studentId, 'history-statuses', historyIds],
    enabled: historyIds.length > 0,
    queryFn: async (): Promise<Record<string, string>> => {
      const { data, error: failed } = await getSupabase()
        .from('v_students')
        .select('id, status')
        .in('id', historyIds);
      if (failed) throw toQueryError(failed);
      const out: Record<string, string> = {};
      for (const row of camelMany<{ id: string; status: string }>(data)) {
        out[row.id] = row.status;
      }
      return out;
    },
  });

  if (isLoading) return <LoadingState label="Loading student…" />;

  if (error instanceof QueryError) {
    return (
      <div className="space-y-4">
        <ErrorState message={error.userMessage} onRetry={() => void refetch()} />
        <Button onClick={() => navigate('/app/students')}>Back to students</Button>
      </div>
    );
  }

  if (!record) return null;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/app/students" className="text-sm text-brand-700 underline-offset-2 hover:underline">
            ← Students
          </Link>
          <h1 className="mt-1 page-title">{record.fullName}</h1>
          <p className="tabular mt-1 text-sm text-ink-muted">
            {record.studentNumber}
            {record.admissionNumber && ` · admission ${record.admissionNumber}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={record.status === 'active' ? 'success' : 'neutral'}>{record.status}</Badge>
          {can(user, PERMISSIONS.REPORT_VIEW_ASSIGNED) && (
            <LinkButton to={`/app/reports?studentId=${record.id}`} size="sm" variant="primary">
              View report
            </LinkButton>
          )}
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader title="Enrolment" />
          <dl className="space-y-3 text-sm">
            <Row label="Class" value={`${record.className ?? '—'}-${record.sectionName ?? '—'}`} />
            <Row label="Roll number" value={record.rollNumber === null ? '—' : String(record.rollNumber)} />
            <Row label="Academic year" value={record.academicYearName ?? '—'} />
            <Row label="Date of birth" value={formatDate(record.dateOfBirth)} />
            <Row label="Gender" value={record.gender ?? '—'} />
          </dl>
        </Card>

        <Card>
          <CardHeader title="Guardian" />
          <dl className="space-y-3 text-sm">
            <Row label="Name" value={record.guardianName ?? '—'} />
            <Row label="Phone" value={record.guardianPhone ?? '—'} />
            <Row label="Email" value={record.guardianEmail ?? '—'} />
          </dl>
        </Card>

        <Card>
          <CardHeader title="Contact" />
          <dl className="space-y-3 text-sm">
            <Row label="Address" value={record.address ?? '—'} />
            <Row label="Record created" value={formatDate(record.createdAt)} />
          </dl>
        </Card>
      </div>

      <Card flush>
        <div className="p-5 pb-0">
          <CardHeader
            title="Academic history"
            description="Each academic year is a separate record, so past results are never rewritten."
          />
        </div>

        {!history ? (
          <LoadingState label="Loading history…" />
        ) : history.length === 0 ? (
          <div className="p-5 pt-0">
            <EmptyState title="No history yet" icon="📚" />
          </div>
        ) : (
          <Table caption="Academic history">
            <THead>
              <tr>
                <TH>Year</TH>
                <TH>Class</TH>
                <TH numeric>Roll</TH>
                <TH numeric>Total marks</TH>
                <TH numeric>Percentage</TH>
                <TH>Grade</TH>
                <TH>Result</TH>
                <TH>Status</TH>
              </tr>
            </THead>
            <TBody>
              {history.map((entry: StudentHistoryRow) => (
                <TR key={entry.id}>
                  <TD className="whitespace-nowrap font-medium text-ink">
                    {entry.academicYearName}
                  </TD>
                  <TD className="whitespace-nowrap text-ink">
                    {entry.className ?? '—'}-{entry.sectionName ?? '—'}
                  </TD>
                  <TD numeric className="tabular text-ink-muted">
                    {entry.rollNumber ?? '—'}
                  </TD>
                  <TD numeric className="tabular text-ink">
                    {entry.totalMarksObtained} / {entry.totalMaxMarks}
                  </TD>
                  <TD numeric className="tabular text-ink">
                    {formatPercent(entry.percentage)}
                  </TD>
                  <TD className="tabular font-medium text-ink">{entry.grade ?? '—'}</TD>
                  <TD>
                    {entry.isPass === null ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      <ToneBadge tone={entry.isPass ? 'success' : 'danger'}>
                        {entry.isPass ? 'Pass' : 'Fail'}
                      </ToneBadge>
                    )}
                  </TD>
                  <TD>
                    <Badge tone={historyStatuses?.[entry.id] === 'active' ? 'success' : 'neutral'}>
                      {historyStatuses?.[entry.id] ?? '—'}
                    </Badge>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Alert tone="info" title="Historical records are immutable">
        When a student is promoted, a new record is created for the new academic year. Previous years
        keep their original class, section and marks so year-on-year comparisons stay accurate.
      </Alert>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-ink-subtle">{label}</dt>
      <dd className="text-right font-medium text-ink">{value}</dd>
    </div>
  );
}