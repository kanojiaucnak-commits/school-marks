import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ExportJob } from '@school/shared';
import { QueryError } from '../../lib/query';
import { useAcademicYearOptions } from '../../hooks/useAcademicYears';
import {
  downloadFromUrl,
  getExportDownloadUrl,
  listExports,
  requestExport,
} from '../../lib/repos/storage';
import { formatBytes, formatDateTime, pluralise } from '../../lib/utils';
import { Badge, ToneBadge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Field';
import { Card, CardHeader, Pagination, Table, TBody, TD, TH, THead, TR } from '../../components/ui/Table';
import { Alert, EmptyState, LoadingState } from '../../components/ui/States';
import { useToast } from '../../components/ui/Toast';
import { useListQuery, type ListParams } from '../../hooks/useListQuery';
import { IconDownload, IconRefresh } from '../../components/ui/icons';

/**
 * Exports.
 *
 * The server builds the file, writes it to private Storage, and the browser
 * downloads it through a short-lived signed URL.
 *
 * These used to be described as "asynchronous" and were marked `QUEUED` past a row
 * threshold, on the assumption a queue consumer would pick them up. That consumer
 * was part of the retired Cloudflare Worker and was never rebuilt, so any large
 * export was accepted, shown as queued, and never produced. Everything now runs
 * inline in the request and the job reaches `COMPLETED` or `FAILED` — the status
 * column below is a real outcome, not a promise.
 */
export default function ExportsPage() {
  const queryClient = useQueryClient();
  const { success, error: errorToast } = useToast();

  const [kind, setKind] = useState('students');
  const [format, setFormat] = useState('csv');
  const [academicYearId, setAcademicYearId] = useState('');

  const fetcher = useCallback((params: ListParams) => listExports(params), []);

  const list = useListQuery<ExportJob>({ key: ['exports'], fetcher });

  const { academicYears: years } = useAcademicYearOptions();

  const request = useMutation({
    mutationFn: () =>
      requestExport({
        kind,
        format,
        params: { academicYearId: academicYearId || undefined },
      }),
    onSuccess: (data) => {
      success('Export ready', data.message);
      void queryClient.invalidateQueries({ queryKey: ['exports'] });
    },
    onError: (caught) =>
      errorToast(
        caught instanceof QueryError ? caught.userMessage : 'Could not start the export.',
      ),
  });

  const download = async (jobId: string, jobFormat: string) => {
    try {
      await downloadFromUrl(await getExportDownloadUrl(jobId), `export.${jobFormat}`);
      success('Download started');
    } catch (caught) {
      errorToast(caught instanceof QueryError ? caught.userMessage : 'The download failed.');
    }
  };

  const statusTone = (status: ExportJob['status']) =>
    status === 'COMPLETED'
      ? 'success'
      : status === 'FAILED'
        ? 'danger'
        : 'warning';

  return (
    <div className="space-y-5">
      <header>
        <h1 className="page-title">
          Large exports run in the background so they never time out the browser.
        </h1>
      </header>

      <Alert tone="info" title="Why this exists">
        Every export is generated on the server and stored privately, then downloaded through a
        short-lived signed URL — a school-sized XLSX is never assembled in the browser. Exports
        above 50,000 rows are refused rather than queued, since nothing here runs in the
        background.
      </Alert>

      <Card>
        <CardHeader title="Request an export" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Select
            label="What to export"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            options={[
              { value: 'students', label: 'All students' },
              { value: 'class-report', label: 'Class report' },
              { value: 'subject-report', label: 'Subject report' },
              { value: 'submission-report', label: 'Submission report' },
            ]}
          />

          <Select
            label="Format"
            value={format}
            onChange={(event) => setFormat(event.target.value)}
            options={[
              { value: 'csv', label: 'CSV' },
              { value: 'xlsx', label: 'Excel (XLSX)' },
              { value: 'json', label: 'JSON' },
            ]}
          />

          <Select
            label="Academic year (optional)"
            value={academicYearId}
            onChange={(event) => setAcademicYearId(event.target.value)}
            options={years.map((year) => ({ value: year.id, label: year.name }))}
            placeholder="All years"
          />
        </div>

        <div className="mt-4 flex justify-end">
          <Button variant="primary" loading={request.isPending} onClick={() => request.mutate()}>
            Request export
          </Button>
        </div>
      </Card>

      <Card flush>
        {list.isLoading && <LoadingState label="Loading exports…" />}

        {list.isEmpty && (
          <div className="p-5">
            <EmptyState title="No exports yet" description="Request one above." icon="📦" />
          </div>
        )}

        {list.items.length > 0 && (
          <>
            <Table caption="Export jobs">
              <THead>
                <tr>
                  <TH>Type</TH>
                  <TH>Format</TH>
                  <TH>Status</TH>
                  <TH>Requested</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {list.items.map((job) => (
                  <TR key={job.id}>
                    <TD className="font-medium text-ink">{job.kind.replace(/-/g, ' ')}</TD>
                    <TD>
                      <Badge tone="accent">{job.format.toUpperCase()}</Badge>
                    </TD>
                    <TD>
                      <ToneBadge tone={statusTone(job.status)}>{job.status}</ToneBadge>
                      {job.error && (
                        <span className="mt-0.5 block max-w-xs truncate text-xs text-rose-700">
                          {job.error}
                        </span>
                      )}
                    </TD>
                    <TD className="tabular whitespace-nowrap text-ink-muted">
                      {formatDateTime(job.createdAt)}
                    </TD>
                    <TD>
                      <div className="flex justify-end gap-1.5">
                        {job.status === 'COMPLETED' ? (
                          <Button
                            size="sm"
                            icon={<IconDownload size={14} />}
                            onClick={() => download(job.id, job.format)}
                          >
                            Download
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<IconRefresh size={14} />}
                            onClick={() => void queryClient.invalidateQueries({ queryKey: ['exports'] })}
                          >
                            Refresh
                          </Button>
                        )}
                      </div>
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
              extra={<p className="text-xs text-ink-subtle">{pluralise(list.total, 'job')}</p>}
            />
          </>
        )}
      </Card>
    </div>
  );
}
