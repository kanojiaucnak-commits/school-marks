import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  ALLOWED_UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
  OCR_STATUS,
  PERMISSIONS,
  type OcrDocument,
  type TeacherAssignment,
} from '@school/shared';
import { useAuth } from '../../lib/auth';
import { QueryError } from '../../lib/query';
import { can } from '../../lib/permissions';
import {
  listAssignments,
  listExams,
  listSubjects,
} from '../../lib/repos/academic';
import {
  getProviderStatus,
  listOcrDocuments,
  validateUploadFile,
} from '../../lib/repos/storage';
import { scanMarkSheet, type ScanProgress } from '../../lib/ocr/pipeline';
import { formatBytes, formatDateTime, pluralise } from '../../lib/utils';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Field';
import { Card, CardHeader, Table, TBody, TD, TH, THead, TR } from '../../components/ui/Table';
import { Alert, EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { useToast } from '../../components/ui/Toast';
import { useAcademicYears } from '../../hooks/useAcademicYears';
import { ScanProgressPanel } from '../../components/ocr/ScanProgressPanel';
import { IconFile, IconRefresh, IconScan, IconUpload } from '../../components/ui/icons';

/**
 * OCR upload and document list.
 *
 * The upload form is a drag-and-drop zone plus a standard file input (the input
 * stays keyboard-accessible; the drop zone is an enhancement). Validation is
 * duplicated client-side purely to give immediate feedback — the Edge Function
 * checks the file's magic bytes regardless.
 *
 * Reading the sheet happens here, in the browser, with Tesseract.js. There is no
 * vendor key to configure and nothing waits on a remote OCR service, so an upload
 * no longer finishes with "queued" and a poll. The work does take a few seconds on
 * a phone, which is why `ScanProgressPanel` reports what it is doing rather than
 * leaving the button spinning: the first run also downloads ~10 MB of OCR engine,
 * and "nothing is happening" is the wrong thing to show someone at that moment.
 */
export default function OcrUploadPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { success, error: errorToast } = useToast();

  const [academicYearId, setAcademicYearId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [examId, setExamId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  /** Non-null while a scan is running; drives the progress panel. */
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canUpload = can(user, PERMISSIONS.OCR_UPLOAD);

  const { data: yearsData } = useAcademicYears();

  useEffect(() => {
    if (academicYearId || !yearsData) return;
    const initial = yearsData.current ?? yearsData.academicYears[0];
    if (initial) setAcademicYearId(initial.id);
  }, [yearsData, academicYearId]);

  const { data: assignments } = useQuery({
    queryKey: ['assignments', 'mine', academicYearId],
    queryFn: () =>
      listAssignments({ academicYearId, teacherId: user?.id }),
    enabled: Boolean(academicYearId && user?.id),
  });

  const sectionOptions = Array.from(
    new Map(
      (assignments ?? []).map((assignment) => [
        assignment.sectionId,
        `Class ${assignment.className ?? '?'} · Section ${assignment.sectionName ?? '?'}`,
      ]),
    ).entries(),
  ).map(([value, label]) => ({ value, label }));

  const subjectOptions = Array.from(
    new Map(
      (assignments ?? [])
        .filter((assignment) => assignment.sectionId === sectionId)
        .map((assignment) => [assignment.subjectId, `${assignment.subjectCode ?? ''} · ${assignment.subjectName ?? ''}`]),
    ).entries(),
  ).map(([value, label]) => ({ value, label }));

  const { data: exams } = useQuery({
    queryKey: ['exams', academicYearId],
    queryFn: () => listExams(academicYearId),
    enabled: Boolean(academicYearId),
  });

  // The subject dropdown is built from the teacher's own assignments, not from
  // this list. Kept because it is cheap, cached under the same `['subjects']` key
  // the reports and marks screens read, and the row set it returns is what those
  // screens share.
  useQuery({
    queryKey: ['subjects'],
    queryFn: () => listSubjects(),
    staleTime: 10 * 60_000,
  });

  // Auto-select the single obvious option to save a click.
  useEffect(() => {
    if (!sectionId && sectionOptions.length === 1) setSectionId(sectionOptions[0]?.value ?? '');
  }, [sectionOptions, sectionId]);

  useEffect(() => {
    if (!subjectId && subjectOptions.length === 1) setSubjectId(subjectOptions[0]?.value ?? '');
  }, [subjectOptions, subjectId]);

  useEffect(() => {
    if (!examId && exams?.length) setExamId(exams[0]?.id ?? '');
  }, [exams, examId]);

  /* ---------------------------------------------------------------------- */

  /**
   * Upload → read → match, as one user-visible action.
   *
   * `scanMarkSheet` reports progress through the callback, which is the only
   * feedback available: recognition happens in a worker thread and neither the
   * button's spinner nor a toast can say how far along it is. The navigation on
   * success is to the review screen rather than back here, because the teacher
   * always has something to do next — verify rows — and the review screen is
   * where that starts.
   */
  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('No file selected');

      return scanMarkSheet(
        file,
        {
          academicYearId,
          classId: classIdFromSelection(assignments ?? [], sectionId) ?? '',
          sectionId,
          subjectId,
          examId,
        },
        setProgress,
      );
    },
    onSuccess: ({ document, resultCount, needsReview }) => {
      setFile(null);
      setProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      success(
        `Read ${pluralise(resultCount, 'row')}`,
        needsReview > 0
          ? `${needsReview} need a second look before they can be saved.`
          : 'Check each one against the original before saving.',
      );
      void queryClient.invalidateQueries({ queryKey: ['ocr', 'documents'] });
      navigate(`/app/ocr/${document.id}`);
    },
    onError: (caught) => {
      // The panel is cleared so the form is usable again; the reason is carried
      // by the toast, which names the cause rather than a generic failure.
      setProgress(null);
      errorToast(
        caught instanceof QueryError
          ? caught.userMessage
          : 'The mark sheet could not be read. Please try again.',
      );
    },
  });

  const {
    data: documentsData,
    isLoading: documentsLoading,
    error: documentsError,
  } = useQuery({
    queryKey: ['ocr', 'documents'],
    queryFn: () =>
      listOcrDocuments({ page: 1, pageSize: 25, mine: user?.id }),
    enabled: Boolean(user?.id),
  });

  const { data: providerData } = useQuery({
    queryKey: ['ocr', 'providers'],
    queryFn: () => getProviderStatus(),
  });

  const activeProvider = providerData?.providers.find((provider) => provider.name === providerData.activeProvider);

  const handleFile = (candidate: File | null) => {
    setLocalError(null);
    if (!candidate) return;

    if (candidate.size > MAX_UPLOAD_BYTES) {
      setLocalError(
        `That file is ${formatBytes(candidate.size)}. The limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`,
      );
      return;
    }

    // Empty file, or a type the server will reject: checked here to save the
    // upload. The Edge Function repeats both against the file's magic bytes.
    const problem = validateUploadFile(candidate);
    if (problem) {
      setLocalError(problem);
      return;
    }

    setFile(candidate);
  };

  const selectionComplete = Boolean(academicYearId && sectionId && subjectId && examId && file);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="page-title">
          Upload a photograph or scan of a completed mark sheet. It is read in your browser, so the
          scan is never sent to a third-party service. Extracted values are suggestions only — every
          one must be verified by you before anything is saved.
        </h1>
      </header>

      {activeProvider && !activeProvider.configured && (
        <Alert tone="warning" title="A cloud OCR provider is selected but not set up">
          Mark sheets are normally read in your browser, with no credentials needed. An administrator
          has pointed this deployment at <strong>{activeProvider.label}</strong>, which has no API key
          configured, so reading a sheet will fail. Ask them to clear the selection or add the key.
        </Alert>
      )}

      {canUpload && (
        <Card>
          <CardHeader
            title="Upload a mark sheet"
            description="Accepted formats: JPG, PNG, WEBP and PDF, up to 10 MB. Read in your browser — no account or API key needed."
          />

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Select
              label="Academic year"
              value={academicYearId}
              onChange={(event) => {
                setAcademicYearId(event.target.value);
                setSectionId('');
                setSubjectId('');
              }}
              options={(yearsData?.academicYears ?? []).map((year) => ({
                value: year.id,
                label: `${year.name}${year.isCurrent ? ' (current)' : ''}`,
              }))}
              placeholder="Select a year"
            />

            <Select
              label="Class & section"
              value={sectionId}
              onChange={(event) => {
                setSectionId(event.target.value);
                setSubjectId('');
              }}
              options={sectionOptions}
              placeholder="Select a section"
              disabled={sectionOptions.length === 0}
              hint={sectionOptions.length === 0 ? 'You have no assignments for this year.' : undefined}
            />

            <Select
              label="Subject"
              value={subjectId}
              onChange={(event) => setSubjectId(event.target.value)}
              options={subjectOptions}
              placeholder="Select a subject"
              disabled={subjectOptions.length === 0}
            />

            <Select
              label="Exam"
              value={examId}
              onChange={(event) => setExamId(event.target.value)}
              options={(exams ?? []).map((exam) => ({
                value: exam.id,
                label: `${exam.name} (max ${exam.maxMarks})`,
              }))}
              placeholder="Select an exam"
              disabled={!exams?.length}
            />
          </div>

          <div className="mt-4">
            {/* Drop zone: a visual affordance layered on a real file input, so
                keyboard and screen-reader users get the native control. */}
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                handleFile(event.dataTransfer.files[0] ?? null);
              }}
              className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
                dragging ? 'border-brand-500 bg-brand-50' : 'border-line-strong bg-surface-muted'
              }`}
            >
              <input
                ref={fileInputRef}
                id="ocr-file"
                type="file"
                accept={ALLOWED_UPLOAD_TYPES.join(',')}
                className="sr-only"
                onChange={(event) => handleFile(event.target.files?.[0] ?? null)}
                aria-describedby="ocr-file-hint"
              />

              <span aria-hidden="true" className="mx-auto mb-2 block text-ink-faint">
                <IconUpload size={32} />
              </span>

              <label htmlFor="ocr-file" className="cursor-pointer text-sm font-medium text-brand-700 underline underline-offset-2">
                Choose a file
              </label>{' '}
              <span className="text-sm text-ink-muted">or drag it here</span>

              <p id="ocr-file-hint" className="mt-1.5 text-xs text-ink-subtle">
                {file ? (
                  <span className="font-medium text-ink">
                    {file.name} · {formatBytes(file.size)}
                  </span>
                ) : (
                  'JPG, PNG, WEBP or PDF, up to 10 MB'
                )}
              </p>
            </div>

            {localError && (
              <Alert tone="danger" className="mt-3" onDismiss={() => setLocalError(null)}>
                {localError}
              </Alert>
            )}

            {/* Replaces the button while a scan runs. Progress is shown because
                the work is genuinely slow and local — on a phone the first
                upload spends most of its time downloading the OCR engine, and a
                disabled button with no explanation reads as a broken page. */}
            {progress ? (
              <ScanProgressPanel progress={progress} className="mt-4" />
            ) : (
              <div className="mt-4 flex justify-end">
                <Button
                  variant="primary"
                  disabled={!selectionComplete}
                  icon={<IconScan size={16} />}
                  onClick={() => upload.mutate()}
                >
                  Read this mark sheet
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}

      <Card flush>
        <div className="p-5 pb-0">
          <CardHeader
            title="Your uploads"
            description="Documents you have uploaded. Open one to verify and confirm the extracted marks."
          />
        </div>

        {documentsLoading && <LoadingState label="Loading uploads…" />}

        {documentsError instanceof QueryError && (
          <div className="p-5 pt-0">
            <ErrorState message={documentsError.userMessage} />
          </div>
        )}

        {!documentsLoading && (documentsData?.items.length ?? 0) === 0 && (
          <div className="p-5 pt-0">
            <EmptyState
              title="No uploads yet"
              description="Upload a mark sheet above to extract its marks."
              icon={<IconFile size={18} />}
            />
          </div>
        )}

        {(documentsData?.items.length ?? 0) > 0 && (
          <Table caption="Uploaded OCR documents">
            <THead>
              <tr>
                <TH>Document</TH>
                <TH>Uploaded</TH>
                <TH numeric>
                  Size
                </TH>
                <TH>Status</TH>
                <TH>Confidence</TH>
                <TH>Provider</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </tr>
            </THead>
            <TBody>
              {documentsData?.items.map((document) => (
                <TR key={document.id}>
                  <TD>
                    <p className="truncate font-medium text-ink">{document.originalFilename}</p>
                    <p className="truncate text-xs text-ink-subtle">
                      {formatDateTime(document.createdAt)}
                    </p>
                  </TD>
                  <TD className="tabular whitespace-nowrap text-ink-muted">
                    {formatDateTime(document.createdAt)}
                  </TD>
                  <TD numeric className="tabular text-ink-muted">
                    {formatBytes(document.sizeBytes)}
                  </TD>
                  <TD>
                    <DocumentStatusBadge document={document} />
                  </TD>
                  <TD numeric className="tabular text-ink">
                    {document.overallConfidence !== null
                      ? `${Math.round(document.overallConfidence * 100)}%`
                      : '—'}
                  </TD>
                  <TD className="text-ink-muted">{document.provider}</TD>
                  <TD>
                    <Button
                      size="sm"
                      onClick={() => navigate(`/app/ocr/${document.id}`)}
                      icon={
                        document.status === OCR_STATUS.FAILED ? <IconRefresh size={14} /> : undefined
                      }
                    >
                      {document.status === OCR_STATUS.FAILED ? 'Retry' : 'Open'}
                    </Button>
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

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

function DocumentStatusBadge({ document }: { document: OcrDocument }) {
  const styles: Record<string, { className: string; label: string }> = {
    UPLOADED: { className: 'bg-surface-sunken text-ink ring-line-strong', label: 'Uploaded' },
    QUEUED: { className: 'bg-surface-sunken text-ink ring-line-strong', label: 'Queued' },
    PROCESSING: { className: 'bg-info-50 text-info-800 ring-info-300', label: 'Processing' },
    COMPLETED: { className: 'bg-warning-50 text-warning-800 ring-warning-300', label: 'Needs verification' },
    FAILED: { className: 'bg-danger-50 text-danger-800 ring-danger-300', label: 'Failed' },
    CONFIRMED: { className: 'bg-success-50 text-success-800 ring-success-300', label: 'Confirmed' },
    CANCELLED: { className: 'bg-surface-sunken text-ink ring-line-strong', label: 'Cancelled' },
  };

  const style = styles[document.status] ?? styles['UPLOADED'] ?? { className: '', label: document.status };
  return (
    <Badge className={style.className}>
      {document.status === OCR_STATUS.PROCESSING && (
        <span aria-hidden="true" className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {style.label}
    </Badge>
  );
}

/** The Edge Function needs class_id as well as section_id; derive it from the assignment. */
function classIdFromSelection(
  assignments: TeacherAssignment[],
  sectionId: string,
): string | undefined {
  return assignments.find((assignment) => assignment.sectionId === sectionId)?.classId;
}
