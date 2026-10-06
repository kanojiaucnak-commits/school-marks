import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  PERMISSIONS,
  type ClassSectionRef,
  type Student,
} from '@school/shared';
import { useAuth } from '../../lib/auth';
import { QueryError } from '../../lib/query';
import { can } from '../../lib/permissions';
import { formatDate, pluralise } from '../../lib/utils';
import { listClassSections } from '../../lib/repos/academic';
import { downloadFromUrl, downloadStudentExport } from '../../lib/repos/storage';
import { listStudents } from '../../lib/repos/students';
import { Badge } from '../../components/ui/Badge';
import { Button, LinkButton } from '../../components/ui/Button';
import { Select } from '../../components/ui/Field';
import { Card, Pagination, Table, TBody, TD, TH, THead, TR } from '../../components/ui/Table';
import { Alert, EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { useToast } from '../../components/ui/Toast';
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

  const { data: yearsData } = useAcademicYears();
  const [academicYearId, setAcademicYearId] = useState('');

  const fetcher = useCallback((params: ListParams) => listStudents(params), []);

  const list = useListQuery<Student>({
    key: ['students', academicYearId],
    fetcher,
    initialFilters: {},
  });

  const currentYearId = academicYearId || yearsData?.current?.id || '';

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
                  : 'Add students manually, or import them from a CSV or Excel file.'
              }
              icon={<IconUsers size={18} />}
              action={
                can(user, PERMISSIONS.STUDENT_IMPORT) ? (
                  <LinkButton to="/app/students/import" variant="primary" icon={<IconPlus size={16} />}>
                    Import students
                  </LinkButton>
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
                    <TD className="tabular text-ink">{student.studentNumber}</TD>
                    <TD className="whitespace-nowrap text-ink">
                      {student.className}-{student.sectionName}
                      <span className="block text-xs text-ink-subtle">
                        {student.academicYearName}
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
