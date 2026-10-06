import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  IMPORT_TEMPLATE_COLUMNS,
  type ImportPreview,
  type ImportResult,
} from '@school/shared';
import { QueryError } from '../../lib/query';
import { listClassSections } from '../../lib/repos/academic';
import {
  commitImport,
  downloadImportTemplate,
  previewImport,
} from '../../lib/repos/storage';
import { cn } from '../../lib/utils';
import { Badge, ToneBadge } from '../../components/ui/Badge';
import { Button, LinkButton } from '../../components/ui/Button';
import { Select } from '../../components/ui/Field';
import { Card, CardHeader, Table, TBody, TD, TH, THead, TR } from '../../components/ui/Table';
import { Alert, EmptyState, LoadingState } from '../../components/ui/States';
import { ConfirmDialog } from '../../components/ui/Modal';
import { useAcademicYears } from '../../hooks/useAcademicYears';
import { useToast } from '../../components/ui/Toast';
import { IconDownload, IconFile, IconUpload } from '../../components/ui/icons';

/**
 * CSV / XLSX student import.
 *
 * Strictly three steps: upload → preview → confirm. Nothing reaches the
 * `students` table during upload, and the preview shows every row's validation
 * outcome so the administrator sees exactly what will (and will not) be
 * imported. Partial imports are always reported explicitly.
 */
export default function StudentImportPage() {
  const navigate = useNavigate();
  const { success, error: errorToast } = useToast();

  const [file, setFile] = useState<File | null>(null);
  const [academicYearId, setAcademicYearId] = useState('');
  /**
   * Import destination.
   *
   * Required, because a flat CSV does not record which section each student
   * belongs to. The function refuses rather than guessing — enrolling a class into
   * the wrong section is a data problem nobody notices until marks are entered.
   */
  const [sectionId, setSectionId] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<(ImportResult & { message: string }) | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [templatePending, setTemplatePending] = useState(false);

  const { data: yearsData } = useAcademicYears();

  const { data: sectionsData } = useQuery({
    queryKey: ['class-sections', academicYearId],
    queryFn: () => listClassSections(academicYearId),
    enabled: Boolean(academicYearId),
    staleTime: 5 * 60_000,
  });

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('No file selected');
      if (!sectionId) throw new Error('Choose the section these students belong to');
      const target = sectionsData?.find((s) => s.sectionId === sectionId);
      return previewImport(file, academicYearId, {
        classId: target?.classId,
        sectionId,
      });
    },
    onSuccess: (data) => {
      setPreview(data);
      setResult(null);
      if (data.errorRowCount === 0) {
        success('File validated', `${data.validRowCount} rows are ready to import.`);
      } else {
        errorToast(
          `${data.errorRowCount} of ${data.totalRows} rows have problems`,
          'They will be skipped unless you fix the file and upload it again.',
        );
      }
    },
    onError: (error) => {
      errorToast(
        error instanceof QueryError ? error.userMessage : 'Could not read that file.',
      );
    },
  });

  const commit = useMutation({
    mutationFn: async () => {
      if (!preview?.batchId) throw new Error('No import to apply');
      // The preview echoes back the destination it resolved, so the commit cannot
      // disagree with what the user was shown.
      return commitImport(
        preview.batchId,
        { classId: preview.classId ?? '', sectionId: preview.sectionId ?? sectionId },
        true,
      );
    },
    onSuccess: (data) => {
      setResult(data);
      setCommitOpen(false);
      success('Import complete', data.message);
    },
    onError: (error) => {
      errorToast(error instanceof QueryError ? error.userMessage : 'The import failed.');
    },
  });

  const downloadTemplate = async () => {
    setTemplatePending(true);
    try {
      await downloadImportTemplate();
    } catch (error) {
      errorToast(
        error instanceof QueryError ? error.userMessage : 'The template could not be downloaded.',
      );
    } finally {
      setTemplatePending(false);
    }
  };

  const errorRows = preview?.rows.filter((row) => row.errors.length > 0) ?? [];
  const validRows = preview?.rows.filter((row) => row.errors.length === 0) ?? [];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">
            Upload a CSV or Excel file. Every row is validated and previewed before anything is
            saved.
          </h1>
        </div>
        <Button
          size="sm"
          icon={<IconDownload size={15} />}
          loading={templatePending}
          onClick={() => void downloadTemplate()}
        >
          Download template
        </Button>
      </header>

      <Card>
        <CardHeader
          title="Expected columns"
          description="Column order does not matter, and common aliases (Student ID, Roll No, Name…) are recognised."
        />
        <div className="flex flex-wrap gap-1.5">
          {IMPORT_TEMPLATE_COLUMNS.map((column) => (
            <Badge key={column}>{column}</Badge>
          ))}
        </div>
        <p className="mt-3 text-xs text-ink-subtle">
          Students are enrolled into the section you choose. A student number already used in that
          academic year is skipped rather than overwritten, because last year's result for that
          student must stay intact.
        </p>
      </Card>

      {/* Step 1 — upload */}
      {!preview && (
        <Card>
          <CardHeader title="1. Choose a file" />

          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label="Default academic year"
              value={academicYearId}
              onChange={(event) => setAcademicYearId(event.target.value)}
              options={(yearsData?.academicYears ?? []).map((year) => ({
                value: year.id,
                label: `${year.name}${year.isCurrent ? ' (current)' : ''}`,
              }))}
              placeholder="Select a year"
              hint="Used when the file has no Academic Year column."
              required
            />

            <Select
              label="Enrol into section"
              value={sectionId}
              onChange={(event) => setSectionId(event.target.value)}
              options={(sectionsData ?? []).map((entry) => ({
                value: entry.sectionId,
                label: entry.label,
              }))}
              placeholder={
                academicYearId ? 'Select a section' : 'Choose an academic year first'
              }
              hint="A flat CSV does not record sections, so pick where these students belong."
              disabled={!academicYearId}
              required
            />
          </div>

          <div className="mt-4">
            <label htmlFor="import-file" className="block text-sm font-medium text-ink">
              CSV file
            </label>
            <input
              id="import-file"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="mt-1.5 block w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm shadow-sm file:mr-3 file:rounded file:border-0 file:bg-brand-50 file:px-3 file:py-1 file:text-xs file:font-medium file:text-brand-800"
            />
            <p className="mt-1 text-xs text-ink-subtle">Maximum 5 MB, up to 5,000 rows.</p>
          </div>

          <div className="mt-4 flex justify-end">
            <Button
              variant="primary"
              icon={<IconUpload size={16} />}
              loading={upload.isPending}
              disabled={!file || !academicYearId || !sectionId}
              onClick={() => upload.mutate()}
            >
              Validate file
            </Button>
          </div>
        </Card>
      )}

      {upload.isPending && <LoadingState label="Parsing and validating…" />}

      {/* Step 2 — preview */}
      {preview && !result && (
        <>
          <Card>
            <CardHeader
              title="2. Review the preview"
              description="Nothing has been saved yet."
              actions={
                <Button
                  size="sm"
                  onClick={() => {
                    setPreview(null);
                    setFile(null);
                  }}
                >
                  Choose a different file
                </Button>
              }
            />

            <div className="grid gap-3 sm:grid-cols-3">
              <Summary label="Rows in file" value={preview.totalRows} />
              <Summary label="Ready to import" value={preview.validRowCount} tone="success" />
              <Summary label="With problems" value={preview.errorRowCount} tone={preview.errorRowCount > 0 ? 'danger' : 'neutral'} />
            </div>

            {errorRows.length > 0 && (
              <Alert tone="warning" className="mt-4">
                {errorRows.length} row{errorRows.length === 1 ? '' : 's'} will be skipped. Fix the
                file and upload it again if you want them included — nothing is imported partially
                without your confirmation.
              </Alert>
            )}

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <LinkButton to="/app/students" size="sm">
                Cancel
              </LinkButton>
              <Button
                variant="primary"
                onClick={() => setCommitOpen(true)}
                disabled={preview.validRowCount === 0}
              >
                Import {preview.validRowCount} student
                {preview.validRowCount === 1 ? '' : 's'}
              </Button>
            </div>
          </Card>

          {errorRows.length > 0 && (
            <Card flush>
              <div className="p-5 pb-0">
                <CardHeader
                  title="Rows with problems"
                  description="These will be skipped. The line number refers to the file."
                />
              </div>
              <Table caption="Rows with validation errors">
                <THead>
                  <tr>
                    <TH numeric>Row</TH>
                    <TH>Field</TH>
                    <TH>Value</TH>
                    <TH>Problem</TH>
                  </tr>
                </THead>
                <TBody>
                  {errorRows.flatMap((row) =>
                    row.errors.map((issue, index) => (
                      <TR key={`${row.row}-${issue.field}-${index}`}>
                        <TD numeric className="tabular text-ink-muted">
                          {row.row}
                        </TD>
                        <TD className="whitespace-nowrap text-ink">{issue.field}</TD>
                        <TD className="tabular max-w-[16rem] truncate text-ink-muted">
                          {issue.value || '—'}
                        </TD>
                        <TD className="text-danger-700">{issue.message}</TD>
                      </TR>
                    )),
                  )}
                </TBody>
              </Table>
            </Card>
          )}

          <Card flush>
            <div className="p-5 pb-0">
              <CardHeader
                title="Rows ready to import"
                description="Existing students are flagged so you can see what will be updated."
              />
            </div>
            <div className="max-h-96 overflow-y-auto scrollbar-thin">
              <Table caption="Rows ready to import">
                <THead>
                  <tr>
                    <TH numeric>Row</TH>
                    <TH>Student ID</TH>
                    <TH>Name</TH>
                    <TH numeric>Roll</TH>
                    <TH>Action</TH>
                  </tr>
                </THead>
                <TBody>
                  {validRows.slice(0, 200).map((row) => {
                    const parsed = row.parsed;
                    return (
                      <TR key={row.row}>
                        <TD numeric className="tabular text-ink-subtle">
                          {row.row}
                        </TD>
                        <TD className="tabular text-ink">{parsed?.studentNumber ?? '—'}</TD>
                        <TD className="font-medium text-ink">{parsed?.fullName ?? '—'}</TD>
                        <TD numeric className="tabular text-ink-muted">
                          {parsed?.rollNumber ?? '—'}
                        </TD>
                        <TD>
                          {row.existingStudentId ? (
                            <ToneBadge tone="warning">Will update existing</ToneBadge>
                          ) : (
                            <ToneBadge tone="success">New</ToneBadge>
                          )}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
            {validRows.length > 200 && (
              <p className="border-t border-line px-5 py-2 text-xs text-ink-subtle">
                Showing the first 200 of {validRows.length} valid rows.
              </p>
            )}
          </Card>
        </>
      )}

      {/* Step 3 — result */}
      {result && (
        <Card>
          <CardHeader title="Import complete" />
          <Alert tone={result.errors.length > 0 ? 'warning' : 'success'}>{result.message}</Alert>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Summary label="Created" value={result.created} tone="success" />
            <Summary label="Updated" value={result.updated} tone="accent" />
            <Summary label="Skipped" value={result.skipped} tone={result.skipped > 0 ? 'danger' : 'neutral'} />
          </div>

          {result.errors.length > 0 && (
            <Alert tone="danger" className="mt-4" title="Some rows were skipped">
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-sm">
                {result.errors.slice(0, 8).map((issue, index) => (
                  <li key={index}>
                    Row {issue.row} · {issue.field}: {issue.message}
                  </li>
                ))}
                {result.errors.length > 8 && <li>and {result.errors.length - 8} more…</li>}
              </ul>
            </Alert>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => navigate('/app/students')}>View students</Button>
            <Button
              variant="primary"
              onClick={() => {
                setResult(null);
                setPreview(null);
                setFile(null);
              }}
            >
              Import another file
            </Button>
          </div>
        </Card>
      )}

      {!preview && !upload.isPending && (
        <EmptyState
          title="No file selected yet"
          description="Download the template, fill it in, then upload it here."
          icon={<IconFile size={18} />}
        />
      )}

      <ConfirmDialog
        open={commitOpen}
        onCancel={() => setCommitOpen(false)}
        onConfirm={() => commit.mutate()}
        busy={commit.isPending}
        title="Apply this import?"
        confirmLabel={`Import ${preview?.validRowCount ?? 0} rows`}
        message={
          <div className="space-y-2">
            <p>
              {preview?.validRowCount} student record(s) will be written to the database.
              {errorRows.length > 0 && ` ${errorRows.length} row(s) with problems will be skipped.`}
            </p>
            <p className="text-ink-muted">
              Students that already exist for this academic year will be updated. This action is
              recorded in the audit log.
            </p>
          </div>
        }
      />
    </div>
  );
}

function Summary({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'success' | 'danger' | 'accent';
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        tone === 'success' && 'border-success-200 bg-success-50',
        tone === 'danger' && 'border-danger-200 bg-danger-50',
        tone === 'accent' && 'border-brand-200 bg-brand-50',
        tone === 'neutral' && 'border-line bg-surface-muted',
      )}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</p>
      <p className="tabular mt-1 text-xl font-semibold text-ink">{value}</p>
    </div>
  );
}
