import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { QueryError } from '../../lib/query';
import {
  decideAssignmentRequest,
  listAssignmentRequests,
  type AssignmentRequest,
} from '../../lib/repos/academic';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, Table, TBody, TD, TH, THead, TR } from '../../components/ui/Table';
import { Alert, EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { useCrudMutation } from '../../components/admin/useCrudMutation';
import { useAuth } from '../../lib/auth';
import { PERMISSIONS } from '@school/shared';

/**
 * The approval queue for self-service class requests.
 *
 * This is the other half of `MyClassesPage`. Approving calls
 * `decide_assignment_request`, which writes the `teacher_assignments` row in the
 * same transaction as the status change — so a request can never end up marked
 * approved without the access actually being granted, or the reverse.
 *
 * `assignment:decide` is checked in Postgres. The guard below only avoids showing
 * a button that would be refused.
 */

const STATUS_TONE = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
} as const;

const STATUS_LABEL = {
  pending: '⏳ Pending',
  approved: '✓ Approved',
  rejected: '✕ Declined',
  cancelled: '– Withdrawn',
} as const;

export default function ClassRequestsPage() {
  const { user } = useAuth();
  const [showDecided, setShowDecided] = useState(false);

  const canDecide = Boolean(user?.permissions.includes(PERMISSIONS.ASSIGNMENT_DECIDE));

  const { data: requests, isLoading, error, refetch } = useQuery({
    queryKey: ['assignment-requests', 'all', showDecided],
    queryFn: async (): Promise<AssignmentRequest[]> => {
      const all = await listAssignmentRequests();
      return showDecided ? all : all.filter((entry) => entry.status === 'pending');
    },
  });

  const decide = useCrudMutation<AssignmentRequest, { id: string; decision: 'approved' | 'rejected' }>(
    {
      mutationFn: ({ id, decision }) => decideAssignmentRequest(id, decision),
      // Grants on `assignments` too: approving changes what that teacher can see
      // immediately, and the admin's own list of assignments is worth refreshing.
      invalidates: [['assignment-requests'], ['assignments']],
      successMessage: 'Request decided',
    },
  );

  const pending = (requests ?? []).filter((entry) => entry.status === 'pending');

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">
            Teachers ask for the classes they teach. Approving grants them access to those mark
            sheets.
          </h1>
        </div>
        <Button variant="secondary" onClick={() => setShowDecided((value) => !value)}>
          {showDecided ? 'Show pending only' : 'Show decided too'}
        </Button>
      </header>

      {!canDecide && (
        <Alert tone="warning" title="Read only">
          You do not hold <code>assignment:decide</code>, so you can see requests but not approve
          them.
        </Alert>
      )}

      {!showDecided && !isLoading && pending.length > 0 && (
        <Alert tone="info" title={`${pending.length} awaiting a decision`}>
          A teacher cannot enter marks for a class until one of these is approved.
        </Alert>
      )}

      <Card flush>
        {isLoading && <LoadingState label="Loading requests…" />}
        {error instanceof QueryError && (
          <div className="p-5">
            <ErrorState message={error.userMessage} onRetry={() => void refetch()} />
          </div>
        )}
        {!isLoading && (requests ?? []).length === 0 && (
          <div className="p-5">
            <EmptyState
              title="Nothing waiting"
              description="Requests from teachers will appear here for approval."
              icon="📨"
            />
          </div>
        )}

        {(requests ?? []).length > 0 && (
          <Table caption="Class requests">
            <THead>
              <tr>
                <TH>Teacher</TH>
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
                    <div>{entry.teacherName ?? '—'}</div>
                    {entry.teacherEmail && (
                      <div className="text-xs text-ink-subtle">{entry.teacherEmail}</div>
                    )}
                  </TD>
                  <TD>
                    {entry.className ?? '—'} · {entry.sectionName ?? '—'}
                  </TD>
                  <TD>{entry.subjectName ?? '—'}</TD>
                  <TD>{entry.academicYearName ?? '—'}</TD>
                  <TD>
                    <Badge tone={STATUS_TONE[entry.status]}>{STATUS_LABEL[entry.status]}</Badge>
                  </TD>
                  <TD className="text-right">
                    {entry.status === 'pending' && canDecide && (
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="primary"
                          disabled={decide.isPending}
                          onClick={() =>
                            decide.mutate({ id: entry.id, decision: 'approved' })
                          }
                        >
                          Approve
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={decide.isPending}
                          onClick={() =>
                            decide.mutate({ id: entry.id, decision: 'rejected' })
                          }
                        >
                          Decline
                        </Button>
                      </div>
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
