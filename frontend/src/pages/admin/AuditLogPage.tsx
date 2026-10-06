import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AuditLogEntry } from '@school/shared';
import { QueryError } from '../../lib/query';
import { listAuditActions, listAuditLogs } from '../../lib/repos/admin';
import { formatDateTime, formatRelative } from '../../lib/utils';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Field';
import { Card, Pagination, Table, TBody, TD, TH, THead, TR } from '../../components/ui/Table';
import { Alert, EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { IconSearch } from '../../components/ui/icons';
import { Modal } from '../../components/ui/Modal';
import { useListQuery, type ListParams } from '../../hooks/useListQuery';

/**
 * Audit log viewer.
 *
 * Read-only by design. The table has UPDATE/DELETE triggers that abort, and
 * there is no mutation route — so nothing shown here can be edited or removed,
 * even by an administrator.
 */
export default function AuditLogPage() {
  const [detail, setDetail] = useState<AuditLogEntry | null>(null);

  const fetcher = useCallback((params: ListParams) => listAuditLogs(params), []);

  const list = useListQuery<AuditLogEntry>({
    key: ['audit-logs'],
    fetcher,
    initialFilters: {},
  });

  const { data: actions } = useQuery({
    queryKey: ['audit-logs', 'actions'],
    queryFn: () => listAuditActions(),
    staleTime: 10 * 60_000,
  });

  return (
    <div className="space-y-5">
      <header>
        <h1 className="page-title">
          Every change to marks, users and configuration, with the old value, new value, user and
          time.
        </h1>
      </header>

      <Alert tone="info" title="This log is append-only">
        Entries cannot be edited or deleted — the database itself rejects any attempt. Retention is
        managed by a scheduled maintenance job.
      </Alert>

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <label htmlFor="audit-search" className="block text-sm font-medium text-ink">
              Search
            </label>
            <input
              id="audit-search"
              type="search"
              value={list.searchInput}
              onChange={(event) => list.setSearchInput(event.target.value)}
              placeholder="Email, record id or reason"
              className="mt-1.5 h-10 w-full rounded-lg border border-line-strong px-3 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </div>

          <Select
            label="Action"
            value={(list.filters.action as string) ?? ''}
            onChange={(event) => list.setFilter('action', event.target.value || undefined)}
            options={[
              { value: '', label: 'All actions' },
              ...(actions ?? []).map((action) => ({ value: action, label: action })),
            ]}
          />

          <Select
            label="Record type"
            value={(list.filters.entityType as string) ?? ''}
            onChange={(event) => list.setFilter('entityType', event.target.value || undefined)}
            options={[
              { value: '', label: 'All types' },
              ...[
                'mark',
                'mark_submission',
                'student',
                'user',
                'ocr_document',
                'subject',
                'exam',
                'teacher_assignment',
                'settings',
                'import_batch',
              ].map((type) => ({ value: type, label: type.replace(/_/g, ' ') })),
            ]}
          />
        </div>
      </Card>

      <Card flush>
        {list.isLoading && <LoadingState label="Loading audit entries…" />}

        {list.error instanceof QueryError && (
          <div className="p-5">
            <ErrorState message={list.error.userMessage} onRetry={() => void list.refetch()} />
          </div>
        )}

        {list.isEmpty && (
          <div className="p-5">
            <EmptyState title="No audit entries match" icon={<IconSearch size={18} />} />
          </div>
        )}

        {list.items.length > 0 && (
          <>
            <Table caption="Audit log">
              <THead>
                <tr>
                  <TH>When</TH>
                  <TH>User</TH>
                  <TH>Action</TH>
                  <TH>Record</TH>
                  <TH>Reason</TH>
                  <TH>
                    <span className="sr-only">Details</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {list.items.map((entry) => (
                  <TR key={entry.id}>
                    <TD className="tabular whitespace-nowrap text-ink">
                      <span title={formatDateTime(entry.createdAt)}>{formatRelative(entry.createdAt)}</span>
                    </TD>
                    <TD className="truncate text-ink">{entry.userEmail ?? '—'}</TD>
                    <TD>
                      <Badge tone={toneForAction(entry.action)}>{entry.action}</Badge>
                    </TD>
                    <TD className="text-ink-muted">
                      {entry.entityType}
                      {entry.entityId && (
                        <span className="tabular block truncate text-xs text-ink-faint">
                          {entry.entityId}
                        </span>
                      )}
                    </TD>
                    <TD className="max-w-[16rem] truncate text-ink-muted">{entry.reason ?? '—'}</TD>
                    <TD>
                      <Button size="sm" variant="ghost" onClick={() => setDetail(entry)}>
                        Details
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>

            <Pagination
              page={list.page}
              pageSize={list.pageSize}
              total={list.total}
              onPageChange={list.setPage}
            />
          </>
        )}
      </Card>

      {/* Detail */}
      <Modal
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail?.action ?? 'Audit entry'}
        description={detail ? formatDateTime(detail.createdAt) : undefined}
        size="lg"
      >
        {detail && (
          <div className="space-y-4">
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="User" value={detail.userEmail ?? 'System'} />
              <Field label="Record type" value={detail.entityType} />
              <Field label="Record id" value={detail.entityId ?? '—'} />
              <Field label="IP address" value={detail.ipAddress ?? '—'} />
            </dl>

            {detail.reason && (
              <Alert tone="info" title="Reason given">
                {detail.reason}
              </Alert>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <JsonBlock label="Old value" value={detail.oldValue} />
              <JsonBlock label="New value" value={detail.newValue} />
            </div>

            {detail.userAgent && (
              <p className="break-all text-xs text-ink-faint">User agent: {detail.userAgent}</p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-ink">{value}</dd>
    </div>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</p>
      {/*
        The only dark surface in the app: a raw JSON payload. The text tone is
        `ink-inverted` rather than a light ramp step, because a dark surface is
        the one context where the token's meaning inverts — the light end of a
        neutral ramp reads as "muted text", which is the opposite of what white
        text on a dark field should be.
      */}
      <pre className="scrollbar-thin mt-1 max-h-64 overflow-auto rounded-lg bg-canvas-inverse p-3 text-xs leading-relaxed text-ink-inverted">
        {value === null || value === undefined
          ? '—'
          : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

/** Rough colour grouping so the important actions stand out in a long list. */
function toneForAction(action: string): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  if (action.includes('locked_corrected') || action.includes('deleted') || action.includes('failed')) {
    return 'danger';
  }
  if (action.includes('approved') || action.includes('locked') || action.includes('confirmed')) {
    return 'success';
  }
  if (action.includes('returned') || action.includes('rejected') || action.includes('blocked')) {
    return 'warning';
  }
  if (action.includes('login') || action.includes('password')) return 'info';
  return 'neutral';
}
