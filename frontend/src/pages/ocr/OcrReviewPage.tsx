import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  MARK_STATUS,
  OCR_STATUS,
  PERMISSIONS,
  validateMark,
  type MarkStatus,
  type OcrResultRow,
  type StudentMatchCandidate,
} from '@school/shared';
import { useAuth } from '../../lib/auth';
import { QueryError } from '../../lib/query';
import { can } from '../../lib/permissions';
import {
  confirmOcrDocument,
  getDocumentSignedUrl,
  getOcrDocument,
  searchStudentsForMatch,
  updateOcrResults,
} from '../../lib/repos/storage';
import { rescanDocument, type ScanProgress } from '../../lib/ocr/pipeline';
import { ScanProgressPanel } from '../../components/ocr/ScanProgressPanel';
import { cn, formatRelative, needsAttention, pluralise } from '../../lib/utils';
import { Alert, EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { Button } from '../../components/ui/Button';
import { Badge, MatchBadge } from '../../components/ui/Badge';
import { Card, CardHeader } from '../../components/ui/Table';
import { Meter, PageHeader } from '../../components/ui/Layout';
import { SearchInput } from '../../components/ui/Field';
import { ConfirmDialog, Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { ConfidenceBadge, DocumentViewer } from '../../components/ocr/ReviewParts';
import { IconRefresh, IconSearch, IconUser } from '../../components/ui/icons';

/** A count with its meaning attached — used in the confidence legend. */
function ConfidenceLegend({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className: string;
}) {
  return (
    <span className="flex items-baseline gap-1.5 text-xs">
      <span className={cn('tabular text-sm font-semibold', className)}>{value}</span>
      <span className="text-ink-muted">{label}</span>
    </span>
  );
}

/**
 * OCR review screen.
 *
 * The core interaction is a side-by-side comparison: the original document on the
 * left with the selected row's bounding box highlighted, and the extracted rows
 * on the right. Selecting a row scrolls the image to it; clicking a row in the
 * image selects the matching row.
 *
 * Three rules are enforced in the UI to match the server:
 *   1. A row cannot be verified without a student.
 *   2. An ambiguous match is never auto-assigned — the teacher picks.
 *   3. Confirming writes **draft** marks only; submitting is a separate act.
 *
 * The uploaded scan is not fetched from the app: `getDocumentSignedUrl` mints a
 * 60-second signed URL from a private bucket, refreshed here on a timer.
 */
export default function OcrReviewPage() {
  const { documentId = '' } = useParams<{ documentId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { success, error: errorToast } = useToast();

  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [confidenceFilter, setConfidenceFilter] = useState<'all' | 'low' | 'unverified'>('all');
  const [patch, setPatch] = useState<Record<string, { marks: string; status: string }>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pickerFor, setPickerFor] = useState<OcrResultRow | null>(null);
  /** Non-null while a re-read is running. */
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);

  const canConfirm = can(user, PERMISSIONS.OCR_CONFIRM);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['ocr', 'document', documentId],
    queryFn: () => getOcrDocument(documentId),
    enabled: Boolean(documentId),
  });

  const document = data?.document;
  const rows = data?.results ?? [];
  const breakdown = data?.breakdown ?? { high: 0, medium: 0, low: 0 };

  const dirtyCount = Object.keys(patch).length;

  /**
   * Whether this screen renders the scan at all.
   *
   * Mirrors the status branches below. The signed URL is only minted when the
   * viewer will actually be shown, so a confirmed or failed document does not
   * spend a call on a URL nobody looks at.
   */
  const showsDocument =
    document != null &&
    document.status !== OCR_STATUS.CONFIRMED &&
    document.status !== OCR_STATUS.FAILED &&
    document.status !== OCR_STATUS.PROCESSING &&
    document.status !== OCR_STATUS.QUEUED &&
    document.status !== OCR_STATUS.UPLOADED &&
    rows.length > 0;

  /**
   * A short-lived signed URL for the uploaded bytes.
   *
   * `ocr-file-url` mints a 60-second URL, so it is refreshed on a timer rather
   * than once per mount — otherwise the scan would stop loading part-way through
   * a long review. `keepPreviousData` keeps the current URL in place while the
   * next one is minted, so the document never blanks between refreshes.
   */
  const { data: signedUrl, error: signedUrlError } = useQuery({
    queryKey: ['ocr', 'file-url', documentId],
    queryFn: () => getDocumentSignedUrl(documentId),
    enabled: Boolean(documentId) && showsDocument,
    refetchInterval: 45_000,
    staleTime: 40_000,
    placeholderData: keepPreviousData,
    retry: false,
  });

  /* ---------------------------------------------------------------------- */
  /* Mutations                                                              */
  /* ---------------------------------------------------------------------- */

  const saveEdits = useMutation({
    mutationFn: () =>
      updateOcrResults(
        documentId,
        Object.entries(patch).map(([rowId, value]) => ({
          id: rowId,
          correctedMarks: value.marks,
          correctedStatus: value.status,
        })),
      ),
    onSuccess: () => {
      setPatch({});
      success('Corrections saved');
      void queryClient.invalidateQueries({ queryKey: ['ocr', 'document', documentId] });
    },
    onError: (caught) => {
      errorToast(caught instanceof QueryError ? caught.userMessage : 'Could not save your corrections.');
    },
  });

  const assignStudent = useMutation({
    mutationFn: ({ rowId, studentId }: { rowId: string; studentId: string | null }) =>
      updateOcrResults(documentId, [{ id: rowId, matchedStudentId: studentId }]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ocr', 'document', documentId] });
    },
    onError: (caught) => {
      errorToast(caught instanceof QueryError ? caught.userMessage : 'Could not assign that student.');
    },
  });

  const toggleVerified = useMutation({
    mutationFn: ({ rowId, verified }: { rowId: string; verified: boolean }) =>
      updateOcrResults(documentId, [{ id: rowId, verified }]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ocr', 'document', documentId] });
    },
    onError: (caught) => {
      errorToast(caught instanceof QueryError ? caught.userMessage : 'Could not update that row.');
    },
  });

  /**
   * Re-read the stored upload and rebuild the rows.
   *
   * Not a status reset. The previous retry posted to `ocr-retry`, which cleared
   * the rows, set the document back to `QUEUED` and returned "re-extraction
   * started" — but nothing ever re-ran the extraction, so the page spun on
   * `AutoRefresh` indefinitely. Reading the file here means retry always ends in a
   * real outcome: rows, or a message saying why there are none.
   */
  const retry = useMutation({
    mutationFn: () => rescanDocument(documentId, setScanProgress),
    onSuccess: ({ resultCount, needsReview }) => {
      setScanProgress(null);
      success(
        `Read ${pluralise(resultCount, 'row')} again`,
        needsReview > 0
          ? `${needsReview} need a second look.`
          : 'Check each one against the original.',
      );
      void queryClient.invalidateQueries({ queryKey: ['ocr', 'document', documentId] });
    },
    onError: (caught) => {
      setScanProgress(null);
      errorToast(
        caught instanceof QueryError ? caught.userMessage : 'The mark sheet could not be re-read.',
      );
    },
  });

  const confirm = useMutation({
    // Business Rule 1: confirming is an explicit human act, and it is the only
    // place `markReviewed` becomes true. The dialog below is that act.
    mutationFn: () => confirmOcrDocument(documentId, true),
    onSuccess: (result) => {
      setConfirmOpen(false);
      success('Saved as draft marks', result.message);
      void queryClient.invalidateQueries({ queryKey: ['ocr', 'document', documentId] });
    },
    onError: (caught) => {
      errorToast(caught instanceof QueryError ? caught.userMessage : 'Could not confirm these results.');
    },
  });

  /* ---------------------------------------------------------------------- */
  /* Derived state                                                          */
  /* ---------------------------------------------------------------------- */

  const unverifiedCount = rows.filter((row) => !row.verified).length;
  const verifiedCount = rows.filter((row) => row.verified).length;
  const ambiguousCount = rows.filter((row) => row.candidates.length > 0 && !row.matchedStudentId).length;

  const visibleRows = useMemo(() => {
    if (confidenceFilter === 'low') {
      return rows.filter((row) => needsAttention(row.confidence));
    }
    if (confidenceFilter === 'unverified') {
      return rows.filter((row) => !row.verified);
    }
    return rows;
  }, [rows, confidenceFilter]);

  const selectedRow = useMemo(
    () => rows.find((row) => row.id === selectedRowId) ?? visibleRows[0] ?? null,
    [rows, selectedRowId, visibleRows],
  );

  // Default the selection to the first row needing attention — that is the work.
  useEffect(() => {
    if (selectedRowId || rows.length === 0) return;
    const firstProblem = rows.find((row) => !row.verified || !row.matchedStudentId) ?? rows[0];
    setSelectedRowId(firstProblem?.id ?? null);
  }, [rows, selectedRowId]);

  /* ---------------------------------------------------------------------- */
  /* Render                                                                 */
  /* ---------------------------------------------------------------------- */

  if (isLoading) return <LoadingState label="Loading extracted results…" />;

  if (error instanceof QueryError) {
    return (
      <div className="space-y-4">
        <ErrorState message={error.userMessage} onRetry={() => void refetch()} />
        <Button onClick={() => navigate('/app/ocr')}>Back to uploads</Button>
      </div>
    );
  }

  if (!document) return null;

  if (document.status === OCR_STATUS.CONFIRMED) {
    return (
      <div className="space-y-4">
        <Alert tone="success" title="These results have been confirmed">
          The marks were saved as a draft sheet. Open the marks grid to review them before submitting
          for approval.
        </Alert>
        <Button variant="primary" onClick={() => navigate('/app/marks')}>
          Go to marks entry
        </Button>
      </div>
    );
  }

  if (document.status === OCR_STATUS.FAILED) {
    return (
      <div className="space-y-4">
        <Alert tone="danger" title="Reading the mark sheet failed">
          {document.errorMessage ?? 'The sheet could not be read.'}
        </Alert>

        {scanProgress ? (
          <ScanProgressPanel progress={scanProgress} />
        ) : (
          <Button
            variant="primary"
            onClick={() => retry.mutate()}
            icon={<IconRefresh size={16} />}
          >
            Read it again
          </Button>
        )}

        <p className="text-sm text-ink-muted">
          This re-reads the file you uploaded — nothing new is asked of you.
        </p>
      </div>
    );
  }

  if (
    document.status === OCR_STATUS.PROCESSING ||
    document.status === OCR_STATUS.QUEUED ||
    document.status === OCR_STATUS.UPLOADED
  ) {
    // These three used to mean "a background worker has it, wait". Nothing runs
    // in the background now: `ocr-process` runs synchronously inside the upload
    // action, so a document still sitting here is one whose read was *interrupted*
    // — the engine download failed, the tab was closed, the wifi dropped. Polling
    // such a document every four seconds shows a spinner that never resolves, which
    // is the same dead end the old retry produced.
    //
    // Re-reading is the correct action and it is already available: `retry` fetches
    // the stored file and runs the whole pipeline, so the teacher gets rows or a
    // named reason rather than a wait with no end.
    return (
      <div className="space-y-4">
        <Alert tone="warning" title="This mark sheet has not been read yet">
          The last attempt to read it stopped before it finished, so there are no rows to review.
          The file itself is safe and does not need uploading again.
        </Alert>

        {scanProgress ? (
          <ScanProgressPanel progress={scanProgress} />
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => retry.mutate()} loading={retry.isPending}>
              Read it now
            </Button>
            <Button onClick={() => navigate('/app/ocr')}>Back to uploads</Button>
          </div>
        )}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="space-y-4">
        <Alert tone="warning" title="Nothing was read">
          No marks could be picked from this sheet. Enter them manually, or read it again from a
          clearer, straighter photograph.
        </Alert>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => navigate('/app/marks')}>
            Enter marks manually
          </Button>
          <Button onClick={() => retry.mutate()} loading={retry.isPending}>
            Try OCR again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={document.originalFilename}
        description={`${pluralise(rows.length, 'row')} extracted · uploaded ${formatRelative(document.createdAt)} · ${document.subjectName ?? ''}`}
        actions={
          <Button onClick={() => navigate('/app/ocr')}>Back to uploads</Button>
        }
      />

      {/*
        This alert is the whole point of the screen and it stays visible for the
        duration of the task, rather than being a dismissible banner a user
        clicks past on the first visit.
      */}
      <Alert tone="warning" title="Nothing here is a mark yet">
        These are machine-read suggestions. Compare each value against the original, and confirm
        every row individually. Even after saving, the sheet is a{' '}
        <strong>draft</strong> that still has to be submitted for approval.
      </Alert>

      {/* Progress as a strip, not four KPI cards. */}
      <div className="card-surface px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-ink">
              {verifiedCount} of {rows.length} rows verified
              {ambiguousCount > 0 && ` · ${ambiguousCount} still need a student`}
            </p>
            <p className="mt-0.5 text-xs text-ink-subtle">
              Rows with low confidence are the ones most likely to be wrong.
            </p>
          </div>

          <Meter
            value={verifiedCount}
            max={rows.length || 1}
            label="Verification progress"
            valueLabel={`${Math.round((verifiedCount / Math.max(rows.length, 1)) * 100)}%`}
            tone={verifiedCount === rows.length && rows.length > 0 ? 'success' : 'accent'}
            className="w-48"
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 border-t border-line-soft pt-3">
          <ConfidenceLegend label="Read clearly" value={breakdown.high} className="text-success-strong" />
          <ConfidenceLegend label="Check against the scan" value={breakdown.medium} className="text-warning-strong" />
          <ConfidenceLegend label="Expect to type these" value={breakdown.low} className="text-danger-strong" />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* Left: the original document */}
        <Card flush className="xl:sticky xl:top-16">
          <div className="p-4 pb-2">
            <CardHeader
              title="Original document"
              description="The highlighted area corresponds to the selected row."
            />
          </div>
          {signedUrlError instanceof QueryError ? (
            <div className="p-4">
              <Alert tone="warning" title="Could not display the document">
                {signedUrlError.userMessage}
              </Alert>
            </div>
          ) : signedUrl ? (
            <DocumentViewer
              src={signedUrl}
              highlightBox={selectedRow?.bbox ?? null}
              contentType={document.contentType}
              filename={document.originalFilename}
            />
          ) : (
            <div className="p-4">
              <LoadingState label="Loading document…" />
            </div>
          )}
        </Card>

        {/* Right: the extracted rows */}
        <Card flush>
          <div className="flex flex-wrap items-center justify-between gap-2 p-4 pb-2">
            <CardHeader
              title="Extracted results"
              description={`Click a row to highlight it in the document.`}
            />
            <div
              role="group"
              aria-label="Filter rows"
              className="flex gap-1 rounded-lg border border-line-strong bg-surface p-0.5"
            >
              {(
                [
                  { id: 'all', label: `All (${rows.length})` },
                  { id: 'low', label: `Low confidence (${breakdown.low})` },
                  { id: 'unverified', label: `Unverified (${unverifiedCount})` },
                ] as const
              ).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setConfidenceFilter(option.id)}
                  aria-pressed={confidenceFilter === option.id}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                    confidenceFilter === option.id
                      ? 'bg-brand-600 text-white'
                      : 'text-ink-muted hover:bg-surface-sunken',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <ul className="divide-y divide-line-soft">
            {visibleRows.map((row) => {
              const draft = patch[row.id];
              const marks = draft?.marks ?? row.correctedMarks ?? row.detectedMarks ?? '';
              const status = draft?.status ?? row.correctedStatus ?? inferStatus(row.detectedMarks);
              const validation = validateMark(marks, 100, status as never);
              const selected = row.id === selectedRow?.id;

              return (
                <li key={row.id}>
                  <div
                    className={cn(
                      'flex flex-col gap-2 px-4 py-3 transition-colors',
                      selected ? 'bg-brand-50' : 'hover:bg-surface-muted',
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={row.verified}
                        disabled={!row.matchedStudentId || toggleVerified.isPending}
                        onChange={(event) =>
                          toggleVerified.mutate({ rowId: row.id, verified: event.target.checked })
                        }
                        aria-label={`Mark row ${row.lineIndex + 1} as verified`}
                        className="mt-1 h-4 w-4 shrink-0 cursor-pointer rounded border-line-strong text-brand-600 focus:ring-2 focus:ring-brand-200 disabled:cursor-not-allowed disabled:opacity-40"
                      />

                      <button
                        type="button"
                        onClick={() => setSelectedRowId(row.id)}
                        className="min-w-0 flex-1 text-left"
                        aria-current={selected ? 'true' : undefined}
                      >
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="tabular text-xs font-semibold text-ink-subtle">
                            #{row.lineIndex + 1}
                          </span>
                          <ConfidenceBadge confidence={row.confidence} />
                          {row.detectedIdentifier && (
                            <Badge>{row.detectedIdentifier}</Badge>
                          )}
                        </span>
                        <span className="mt-1 block truncate text-sm text-ink">
                          {row.rawText ?? '—'}
                        </span>
                      </button>
                    </div>

                    {/* Student assignment */}
                    <div className="pl-7">
                      {row.matchedStudentId ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium text-ink">
                            {row.matchedStudentName}
                          </span>
                          <span className="tabular text-xs text-ink-subtle">
                            {row.matchedStudentNumber}
                            {row.matchedRollNumber !== null && ` · roll ${row.matchedRollNumber}`}
                          </span>
                          <MatchMethodBadge method={row.matchMethod} />
                          <button
                            type="button"
                            onClick={() => setPickerFor(row)}
                            className="text-xs font-medium text-brand-700 underline underline-offset-2"
                          >
                            Change
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPickerFor(row)}
                          className={cn(
                            'rounded-md border border-dashed px-2.5 py-1 text-xs font-medium transition-colors',
                            row.candidates.length > 0
                              ? 'border-amber-400 bg-amber-50 text-amber-900'
                              : 'border-line-strong bg-surface text-ink hover:bg-surface-sunken',
                          )}
                        >
                          {row.candidates.length > 0
                            ? `Choose from ${row.candidates.length} possible matches`
                            : 'Assign a student'}
                        </button>
                      )}
                    </div>

                    {/* Corrected mark */}
                    <div className="flex flex-wrap items-end gap-2 pl-7">
                      <div>
                        <label
                          htmlFor={`marks-${row.id}`}
                          className="block text-xs font-medium text-ink"
                        >
                          Mark
                        </label>
                        <input
                          id={`marks-${row.id}`}
                          type="text"
                          inputMode="decimal"
                          value={marks}
                          onChange={(event) =>
                            setPatch((current) => ({
                              ...current,
                              [row.id]: { marks: event.target.value, status },
                            }))
                          }
                          className={cn(
                            'tabular mt-1 h-9 w-24 rounded-md border px-2 text-right text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-500',
                            validation.valid ? 'border-line-strong' : 'border-rose-400 bg-rose-50',
                          )}
                        />
                        {!validation.valid && (
                          <p className="mt-0.5 text-[11px] font-medium text-rose-700">
                            {validation.message}
                          </p>
                        )}
                      </div>

                      <div>
                        <label htmlFor={`status-${row.id}`} className="block text-xs font-medium text-ink">
                          Status
                        </label>
                        <select
                          id={`status-${row.id}`}
                          value={status}
                          onChange={(event) =>
                            setPatch((current) => ({
                              ...current,
                              [row.id]: { marks, status: event.target.value },
                            }))
                          }
                          className="mt-1 h-9 rounded-md border border-line-strong bg-surface px-2 text-xs shadow-sm focus:outline-none focus:ring-2 focus:ring-brand-200"
                        >
                          <option value="PRESENT">Present</option>
                          <option value="ABSENT">Absent</option>
                          <option value="EXEMPTED">Exempted</option>
                          <option value="MEDICAL">Medical</option>
                        </select>
                      </div>

                      <p className="tabular ml-auto text-xs text-ink-subtle">
                        OCR read: <strong>{row.detectedMarks ?? '—'}</strong>
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {visibleRows.length === 0 && (
            <div className="p-5">
              <EmptyState title="No rows match this filter" icon={<IconSearch size={18} />} />
            </div>
          )}

          {/* Actions */}
          <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface-muted px-4 py-3">
            <p className="tabular text-sm text-ink-muted">
              {unverifiedCount === 0 && ambiguousCount === 0
                ? 'All rows verified.'
                : `${unverifiedCount} unverified · ${ambiguousCount} need a student`}
            </p>

            <div className="flex gap-2">
              {dirtyCount > 0 && (
                <Button
                  loading={saveEdits.isPending}
                  onClick={() => saveEdits.mutate()}
                >
                  Save {dirtyCount} correction{dirtyCount === 1 ? '' : 's'}
                </Button>
              )}
              {canConfirm && (
                <Button
                  variant="primary"
                  disabled={unverifiedCount > 0 || ambiguousCount > 0}
                  onClick={() => setConfirmOpen(true)}
                  title={
                    unverifiedCount > 0 || ambiguousCount > 0
                      ? 'Verify every row and assign a student first'
                      : undefined
                  }
                >
                  Confirm and save as draft
                </Button>
              )}
            </div>
          </div>
        </Card>
      </div>

      {/* Student picker */}
      <StudentPicker
        row={pickerFor}
        sectionId={document.sectionId}
        onClose={() => setPickerFor(null)}
        onSelect={(studentId) => {
          if (pickerFor) assignStudent.mutate({ rowId: pickerFor.id, studentId });
          setPickerFor(null);
        }}
      />

      <ConfirmDialog
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => confirm.mutate()}
        busy={confirm.isPending}
        title="Save these marks as a draft?"
        confirmLabel="Save as draft"
        message={
          <div className="space-y-2">
            <p>
              {rows.filter((row) => row.verified && row.matchedStudentId).length} verified row(s) will
              be written to the mark sheet for{' '}
              <strong>{document.examId}</strong>.
            </p>
            <p className="text-ink-muted">
              The sheet will be saved as <strong>DRAFT</strong>. Nothing is submitted, approved or
              locked — you will still open the marks grid to check the values and submit for review.
            </p>
          </div>
        }
      />
    </div>
  );
}

/* ==========================================================================
   Pieces
   ========================================================================== */

/**
 * Guesses the attendance status from what OCR read.
 *
 * OCR often captures "AB" or "—" for an absent student rather than a number.
 * This is only a *suggestion* shown before a human decides — the same value the
 * server infers, so the preview and the saved row agree.
 */
function inferStatus(raw: string | null): MarkStatus {
  const text = (raw ?? '').trim().toUpperCase();
  if (text === '') return MARK_STATUS.PRESENT;

  if (text.startsWith('AB') || text === 'ABS' || text === '-') return MARK_STATUS.ABSENT;
  if (text.startsWith('EX') || text.startsWith('EXEM')) return MARK_STATUS.EXEMPTED;
  if (text.startsWith('MED') || text.startsWith('MC')) return MARK_STATUS.MEDICAL;
  // "P" is often OCR'd for a present mark, and is not a number.
  if (text === 'P' || text === 'PR') return MARK_STATUS.PRESENT;

  return MARK_STATUS.PRESENT;
}

/**
 * How a row was matched to a student.
 *
 * An ambiguous or missing match is deliberately loud — putting a mark on the
 * wrong child is the worst outcome this product can produce.
 */
function MatchMethodBadge({ method }: { method: string }) {
  return <MatchBadge method={method} />;
}

/**
 * Student picker.
 *
 * Used when the matcher could not decide. The candidates OCR proposed are shown
 * first and labelled as suggestions, because they are usually right — but
 * choosing one is still an explicit human act, and the search field is always
 * available so a row with no candidates is not a dead end.
 */
function StudentPicker({
  row,
  sectionId,
  onClose,
  onSelect,
}: {
  row: OcrResultRow | null;
  /** Scopes the search to the section the sheet was uploaded for. */
  sectionId: string;
  onClose: () => void;
  onSelect: (studentId: string) => void;
}) {
  const [term, setTerm] = useState('');

  const search = term.trim().toLowerCase();

  // Server-side match, so the picker is not a filter over a whole school roll.
  // The old client-side `matches` filter is gone: it could not see admission or
  // roll numbers, which is how a scanner reads a student's identifier.
  const { data: students = [] } = useQuery({
    queryKey: ['ocr', 'student-search', sectionId, search],
    queryFn: () => searchStudentsForMatch(term, sectionId),
    enabled: Boolean(row) && search.length > 0,
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => {
    if (!row) return;
    setTerm('');
  }, [row]);

  const candidates = row?.candidates ?? [];

  return (
    <Modal
      open={Boolean(row)}
      onClose={onClose}
      title="Choose the student for this row"
      description={row?.detectedName ? `OCR read "${row.detectedName}" on the scan.` : undefined}
      size="sm"
    >
      <div className="space-y-3">
        {candidates.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-ink-subtle">
              Closest matches the scanner found
            </p>
            <ul className="space-y-1">
              {candidates.map((candidate: StudentMatchCandidate) => (
                <li key={candidate.studentId}>
                  <button
                    type="button"
                    onClick={() => onSelect(candidate.studentId)}
                    className="flex w-full items-center justify-between gap-3 rounded border border-line px-3 py-2 text-left transition-colors hover:border-brand-300 hover:bg-brand-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">
                        {candidate.fullName}
                      </span>
                      <span className="tabular block truncate text-xs text-ink-subtle">
                        {candidate.studentNumber}
                        {candidate.rollNumber !== null ? ` · roll ${candidate.rollNumber}` : ''}
                      </span>
                    </span>
                    <span className="tabular shrink-0 text-xs text-ink-subtle">
                      {Math.round(candidate.confidence * 100)}%
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="my-3 flex items-center gap-3">
              <span className="h-px flex-1 bg-line" />
              <span className="text-2xs uppercase tracking-wide text-ink-faint">or search</span>
              <span className="h-px flex-1 bg-line" />
            </div>
          </div>
        )}

        <SearchInput
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Search by name or student number"
          label="Search students"
          wrapperClassName="w-full"
          controlSize="md"
        />

        {students.length === 0 ? (
          <p className="py-4 text-center text-sm text-ink-muted">
            {search ? 'No student matches that search.' : 'Start typing to search the roll.'}
          </p>
        ) : (
          <ul className="max-h-64 space-y-1 overflow-y-auto scrollbar-thin">
            {students.map((student) => (
              <li key={student.id}>
                <button
                  type="button"
                  onClick={() => onSelect(student.id)}
                  className="flex w-full items-center gap-3 rounded px-3 py-1.5 text-left transition-colors hover:bg-surface-sunken"
                >
                  <span className="tabular w-10 shrink-0 text-right text-xs text-ink-subtle">
                    {student.rollNumber ?? '—'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{student.fullName}</span>
                    <span className="tabular block truncate text-xs text-ink-subtle">
                      {student.studentNumber}
                    </span>
                  </span>
                  <IconUser size={13} className="shrink-0 text-ink-faint" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
