import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'react-router-dom';
import {
  PERMISSIONS,
  createStudentSchema,
  type ClassSectionRef,
  type CreateStudentInput,
  type Student,
} from '@school/shared';
import { useAuth } from '../../lib/auth';
import { QueryError } from '../../lib/query';
import { can } from '../../lib/permissions';
import { formatDate, pluralise } from '../../lib/utils';
import { listAssignments, listClassSections, listClasses } from '../../lib/repos/academic';
import { downloadFromUrl, downloadStudentExport } from '../../lib/repos/storage';
import { createStudent, listStudents } from '../../lib/repos/students';
import { Badge } from '../../components/ui/Badge';
import { Button, LinkButton } from '../../components/ui/Button';
import { Select, TextInput } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Modal';
import { Card, Pagination, Table, TBody, TD, TH, THead, TR } from '../../components/ui/Table';
import { Alert, EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { useToast } from '../../components/ui/Toast';
import { useCrudMutation } from '../../components/admin/useCrudMutation';
import { useAcademicYears } from '../../hooks/useAcademicYears';
import { useListQuery, type ListParams } from '../../hooks/useListQuery';
import { IconDownload, IconPlus, IconUsers } from '../../components/ui/icons';

/**
 * Student directory.
 *
 * Server-side pagination and search throughout — a whole-school roll must never
 * be loaded into the browser. A teacher's results are scoped by RLS to their
 * assigned sections, so the count they see is their count, not the school's.
 */
export default function StudentsPage() {
  const { user } = useAuth();
  const { success, error: errorToast } = useToast();
  const [exporting, setExporting] = useState(false);
  const [adding, setAdding] = useState(false);

  const canCreate = can(user, PERMISSIONS.STUDENT_CREATE);
  const canSeeAll = can(user, PERMISSIONS.STUDENT_VIEW_ALL);

  const { data: yearsData } = useAcademicYears();
  const [academicYearId, setAcademicYearId] = useState('');

  const fetcher = useCallback((params: ListParams) => listStudents(params), []);

  const list = useListQuery<Student>({
    key: ['students', academicYearId],
    fetcher,
    initialFilters: {},
  });

  const currentYearId = academicYearId || yearsData?.current?.id || '';

  /**
   * Enrolment needs an academic year, so without one the Add-student button is
   * off. A control that is simply greyed out reads as broken rather than as
   * waiting on a step before it, which on a freshly-emptied database is exactly
   * the state the first person to use it lands in — so the button says why.
   */
  const noYearReason =
    'Create an academic year first — a student can only be enrolled into one.';

  const { data: classSections } = useClassSections(currentYearId);

  const handleExport = async (format: 'csv' | 'xlsx') => {
    setExporting(true);
    try {
      const url = await downloadStudentExport(
        {
          academicYearId: list.filters.academicYearId as string | undefined,
          classId: list.filters.classId as string | undefined,
          sectionId: list.filters.sectionId as string | undefined,
          status: list.filters.status as string | undefined,
        },
        format,
      );
      await downloadFromUrl(url, `students.${format}`);
      success('Export downloaded');
    } catch (error) {
      errorToast(error instanceof QueryError ? error.userMessage : 'The export failed.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Students</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {can(user, PERMISSIONS.MARKS_VIEW_ALL)
              ? 'Every student in the school.'
              : 'Students in the classes you are assigned to.'}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {canCreate && (
            <Button
              variant="primary"
              size="sm"
              icon={<IconPlus size={16} />}
              disabled={!currentYearId}
              title={currentYearId ? undefined : noYearReason}
              onClick={() => setAdding(true)}
            >
              Add student
            </Button>
          )}
          {can(user, PERMISSIONS.STUDENT_EXPORT) && (
            <>
              <Button
                size="sm"
                icon={<IconDownload size={15} />}
                loading={exporting}
                onClick={() => handleExport('csv')}
              >
                CSV
              </Button>
              <Button
                size="sm"
                icon={<IconDownload size={15} />}
                loading={exporting}
                onClick={() => handleExport('xlsx')}
              >
                Excel
              </Button>
            </>
          )}
          {can(user, PERMISSIONS.STUDENT_IMPORT) && (
            <LinkButton to="/app/students/import" size="sm">
              Import
            </LinkButton>
          )}
        </div>
      </header>

      {/* Filters */}
      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <label htmlFor="student-search" className="block text-sm font-medium text-ink">
              Search
            </label>
            <input
              id="student-search"
              type="search"
              value={list.searchInput}
              onChange={(event) => list.setSearchInput(event.target.value)}
              placeholder="Name, student ID or admission number"
              className="mt-1.5 h-10 w-full rounded-lg border border-line-strong px-3 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </div>

          <Select
            label="Academic year"
            value={currentYearId}
            onChange={(event) => {
              setAcademicYearId(event.target.value);
              list.setFilter('academicYearId', event.target.value || undefined);
            }}
            options={(yearsData?.academicYears ?? []).map((year) => ({
              value: year.id,
              label: year.name,
            }))}
            placeholder="All years"
          />

          <Select
            label="Class & section"
            value={(list.filters.sectionId as string) ?? ''}
            onChange={(event) => list.setFilter('sectionId', event.target.value || undefined)}
            options={(classSections ?? []).map((entry: ClassSectionRef) => ({
              value: entry.sectionId,
              label: `Class ${entry.className} · ${entry.sectionName} (${entry.studentCount})`,
            }))}
            placeholder="All sections"
            disabled={!currentYearId}
          />
        </div>

        {list.isFiltered && (
          <div className="mt-3 flex items-center gap-3">
            <Badge tone="accent">Filters applied</Badge>
            <button
              type="button"
              onClick={() => {
                list.resetFilters();
                setAcademicYearId('');
              }}
              className="text-xs font-medium text-brand-700 underline underline-offset-2"
            >
              Clear all
            </button>
          </div>
        )}
      </Card>

      {/* Table */}
      <Card flush>
        {list.isLoading && <LoadingState label="Loading students…" />}

        {list.error instanceof QueryError && (
          <div className="p-5">
            <ErrorState message={list.error.userMessage} onRetry={() => void list.refetch()} />
          </div>
        )}

        {list.isEmpty && (
          <div className="p-5">
            <EmptyState
              title="No students found"
              description={
                list.isFiltered
                  ? 'Try a different search or clear the filters.'
                  : !currentYearId
                    ? 'Create an academic year, then a class and a section — a student is enrolled into a section, and none exist yet.'
                    : 'Add students manually, or import them from a CSV or Excel file.'
              }
              icon={<IconUsers size={18} />}
              action={
                canCreate || can(user, PERMISSIONS.STUDENT_IMPORT) ? (
                  <div className="flex flex-wrap justify-center gap-2">
                    {canCreate && (
                      <Button
                        variant="primary"
                        icon={<IconPlus size={16} />}
                        disabled={!currentYearId}
                        title={currentYearId ? undefined : noYearReason}
                        onClick={() => setAdding(true)}
                      >
                        Add student
                      </Button>
                    )}
                    {can(user, PERMISSIONS.STUDENT_IMPORT) && (
                      <LinkButton
                        to="/app/students/import"
                        variant={canCreate ? 'secondary' : 'primary'}
                        icon={<IconPlus size={16} />}
                      >
                        Import students
                      </LinkButton>
                    )}
                  </div>
                ) : undefined
              }
            />
          </div>
        )}

        {list.items.length > 0 && (
          <>
            <Table caption="Student directory">
              <THead>
                <tr>
                  <TH numeric>Roll</TH>
                  <TH>Student</TH>
                  <TH>Student ID</TH>
                  <TH>Class</TH>
                  <TH>Date of birth</TH>
                  <TH>Guardian</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <TBody>
                {list.items.map((student) => (
                  <TR key={student.id} onClick={() => undefined}>
                    <TD numeric className="tabular text-ink-muted">
                      {student.rollNumber ?? '—'}
                    </TD>
                    <TD>
                      <Link
                        to={`/app/students/${student.id}`}
                        className="font-medium text-brand-700 underline-offset-2 hover:underline"
                      >
                        {student.fullName}
                      </Link>
                      <span className="tabular block text-xs text-ink-subtle">
                        {student.admissionNumber ?? ''}
                      </span>
                    </TD>
                    <TD className="tabular text-ink">{student.studentNumber ?? '—'}</TD>
                    <TD className="whitespace-nowrap text-ink">
                      {student.className ?? '—'}-{student.sectionName ?? '—'}
                      <span className="block text-xs text-ink-subtle">
                        {student.academicYearName ?? '—'}
                      </span>
                    </TD>
                    <TD className="tabular whitespace-nowrap text-ink-muted">
                      {formatDate(student.dateOfBirth)}
                    </TD>
                    <TD>
                      <span className="block truncate text-ink">{student.guardianName ?? '—'}</span>
                      <span className="tabular block truncate text-xs text-ink-subtle">
                        {student.guardianPhone ?? ''}
                      </span>
                    </TD>
                    <TD>
                      <Badge tone={student.status === 'active' ? 'success' : 'neutral'}>
                        {student.status}
                      </Badge>
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
              extra={
                <p className="text-xs text-ink-subtle">{pluralise(list.total, 'student')}</p>
              }
            />
          </>
        )}
      </Card>

      {adding && currentYearId && (
        <AddStudentDialog
          onClose={() => setAdding(false)}
          academicYearId={currentYearId}
          canSeeAll={canSeeAll}
          teacherId={user?.id}
        />
      )}
    </div>
  );
}


function useClassSections(academicYearId: string) {
  return useQuery({
    queryKey: ['class-sections', academicYearId],
    queryFn: () => listClassSections(academicYearId),
    enabled: Boolean(academicYearId),
    staleTime: 5 * 60_000,
  });
}

/* -------------------------------------------------------------------------- */
/* Add student dialog                                                          */
/* -------------------------------------------------------------------------- */

/**
 * An empty text input becomes `NULL`, so optional columns do not fill with `''`.
 *
 * It has to tolerate `null` as well as `''`, because react-hook-form runs every
 * `setValueAs` back over the field's own default value as the input mounts — and
 * these optional fields default to `null`, which is what the column holds. On
 * the first frame the callback is therefore handed `null` rather than a string,
 * and trimming it unconditionally threw during commit and took the page down.
 */
const blankToNull = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * Enrol one student by hand, for a mid-year joiner the import is not worth it for.
 *
 * The section picker mirrors `students_insert` rather than consulting a separate
 * rule: an admin or reviewer (`student:view_all`) may file a student into any
 * section of the year, a teacher only into one they hold an assignment for or
 * class-teach. Offering exactly that set is the whole point — anything wider is
 * a button that ends in a write the database refuses, anything narrower hides a
 * section it would have accepted.
 *
 * Mounted only while open. `academicYearId` arrives as context rather than as
 * something the user types, so the form has to be seeded with it on each open
 * rather than once at page load, before the years have even resolved.
 */
function AddStudentDialog({
  onClose,
  academicYearId,
  canSeeAll,
  teacherId,
}: {
  onClose: () => void;
  academicYearId: string;
  canSeeAll: boolean;
  teacherId: string | undefined;
}) {
  // Keyed as `ClassesPage` keys it, so a section list already fetched is reused.
  const { data: programs, error: programsError, isPending: programsPending } = useQuery({
    queryKey: ['classes', academicYearId],
    queryFn: () => listClasses(academicYearId),
    staleTime: 5 * 60_000,
  });

  // Keyed as `MarksEntryPage` keys it, for the same reason.
  const { data: assignments, isPending: assignmentsPending } = useQuery({
    queryKey: ['assignments', 'mine', academicYearId],
    queryFn: () => listAssignments({ academicYearId, teacherId: teacherId! }),
    enabled: !canSeeAll && Boolean(academicYearId && teacherId),
    staleTime: 5 * 60_000,
  });

  // A disabled query reports `isPending` forever, so it only counts while it is
  // actually going to run. Without this the dialog would spend its first frame
  // telling an admin that this year has no classes.
  const loadingSections =
    programsPending || (!canSeeAll && assignmentsPending && Boolean(teacherId));

  const assignable = useMemo(() => {
    const assigned = new Set((assignments ?? []).map((row) => row.sectionId));
    const classes = programs?.classes ?? [];
    const classNameOf = (classId: string) =>
      classes.find((row) => row.id === classId)?.name ?? '?';

    const rows = (programs?.sections ?? [])
      .filter(
        (section) =>
          canSeeAll || assigned.has(section.id) || section.classTeacherId === teacherId,
      )
      .map((section) => ({
        classId: section.classId,
        sectionId: section.id,
        className: classNameOf(section.classId),
        sectionName: section.name,
      }));

    // Numeric so "Class 10" sorts before "Class 9".
    return rows.sort(
      (a, b) =>
        a.className.localeCompare(b.className, undefined, { numeric: true }) ||
        a.sectionName.localeCompare(b.sectionName),
    );
  }, [programs, assignments, canSeeAll, teacherId]);

  const create = useCrudMutation<Student, CreateStudentInput>({
    mutationFn: (values) => createStudent(values),
    invalidates: [['students'], ['class-sections']],
    successMessage: 'Student added',
    onSuccess: () => onClose(),
  });

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<CreateStudentInput>({
    resolver: zodResolver(createStudentSchema),
    defaultValues: {
      fullName: '',
      studentNumber: '',
      admissionNumber: null,
      rollNumber: null,
      dateOfBirth: null,
      gender: null,
      classId: '',
      sectionId: '',
      academicYearId,
      guardianName: null,
      guardianPhone: null,
      guardianEmail: null,
      address: null,
      status: 'active',
    },
  });

  const sectionField = register('sectionId');
  const classIdFor = (sectionId: string) =>
    assignable.find((row) => row.sectionId === sectionId)?.classId ?? '';

  return (
    <Modal
      open
      onClose={onClose}
      title="Add a student"
      description="Enrols one student into a class for the academic year shown in the page filters."
      busy={create.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={loadingSections || assignable.length === 0}
            onClick={handleSubmit((values) => create.mutate(values))}
          >
            Add student
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit((values) => create.mutate(values))();
        }}
      >
        {create.fieldError && <Alert tone="danger">{create.fieldError}</Alert>}

        {programsError instanceof QueryError && (
          <Alert tone="danger">{programsError.userMessage}</Alert>
        )}

        {!programsError && !loadingSections && assignable.length === 0 && (
          <Alert tone="info">
            {canSeeAll
              ? 'This academic year has no classes yet, so there is nowhere to enrol a student.'
              : 'You are not assigned to any section yet, so there is nowhere to enrol a student.'}
          </Alert>
        )}

        <TextInput
          label="Full name"
          autoComplete="name"
          error={errors.fullName?.message}
          {...register('fullName')}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput
            label="Student ID"
            hint="Letters, numbers and hyphens. Unique within the academic year."
            error={errors.studentNumber?.message}
            {...register('studentNumber')}
          />
          <TextInput
            label="Roll number"
            type="number"
            hint="Unique within the section."
            error={errors.rollNumber?.message}
            {...register('rollNumber', {
              // The same mount-time `null` `blankToNull` defends against: a roll
              // number the teacher never typed is absent, and absent must stay
              // `null` rather than become `0`, which would be a real number.
              setValueAs: (value: unknown) =>
                value === null || value === undefined || String(value).trim() === ''
                  ? null
                  : Number(value),
            })}
          />
        </div>

        <Select
          label="Class & section"
          required
          placeholder={
            loadingSections
              ? 'Loading sections…'
              : assignable.length === 0
                ? 'No section is available to you'
                : 'Choose a class and section'
          }
          disabled={loadingSections || assignable.length === 0}
          options={assignable.map((row) => ({
            value: row.sectionId,
            label: `Section ${row.sectionName ?? '—'}`,
            group: `Class ${row.className ?? '—'}`,
          }))}
          error={errors.sectionId?.message ?? errors.classId?.message}
          {...sectionField}
          onChange={(event) => {
            sectionField.onChange(event);
            // The schema wants the class as a column of its own, but it is
            // implied by the section — so it is filled in here rather than
            // asking for the same thing twice.
            setValue('classId', classIdFor(event.target.value));
          }}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput
            label="Date of birth"
            type="date"
            error={errors.dateOfBirth?.message}
            {...register('dateOfBirth', {
              setValueAs: (value: string) => (value === '' ? null : value),
            })}
          />
          <Select
            label="Gender"
            placeholder="Not stated"
            options={[
              { value: 'male', label: 'Male' },
              { value: 'female', label: 'Female' },
              { value: 'other', label: 'Other' },
            ]}
            error={errors.gender?.message}
            {...register('gender', { setValueAs: (value: string) => (value === '' ? null : value) })}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput
            label="Guardian name (optional)"
            autoComplete="name"
            error={errors.guardianName?.message}
            {...register('guardianName', { setValueAs: blankToNull })}
          />
          <TextInput
            label="Guardian phone (optional)"
            type="tel"
            autoComplete="tel"
            error={errors.guardianPhone?.message}
            {...register('guardianPhone', { setValueAs: blankToNull })}
          />
        </div>

        <TextInput
          label="Admission number (optional)"
          error={errors.admissionNumber?.message}
          {...register('admissionNumber', { setValueAs: blankToNull })}
        />
      </form>
    </Modal>
  );
}
