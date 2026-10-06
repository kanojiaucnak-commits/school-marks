import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TeacherAssignment } from '@school/shared';
import { QueryError } from '../../lib/query';
import {
  createAssignment,
  deleteAssignment,
  listAssignments,
  listClassSections,
  listSubjects,
} from '../../lib/repos/academic';
import { listTeachers } from '../../lib/repos/admin';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Field';
import { Card, Table, TBody, TD, TH, THead, TR } from '../../components/ui/Table';
import { Alert, EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/Toast';
import { useCrudMutation } from '../../components/admin/useCrudMutation';
import { useAcademicYears } from '../../hooks/useAcademicYears';
import { IconPlus } from '../../components/ui/icons';

/**
 * Teacher assignments — the authorisation boundary.
 *
 * Creating one here is what grants a teacher access to a class/section/subject
 * combination. Nothing else in the system grants it, and RLS on
 * `v_teacher_assignments` is what checks it on every marks request, so removing
 * an assignment here immediately removes their access.
 *
 * Reads go through the view and writes through PostgREST; `assignment:manage` is
 * enforced by the database, not by hiding a button.
 */
export default function AssignmentsPage() {
  const queryClient = useQueryClient();
  const { success } = useToast();

  const [academicYearId, setAcademicYearId] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [sectionId, setSectionId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!academicYearId) return;
    void queryClient.invalidateQueries({ queryKey: ['assignments'] });
  }, [academicYearId, queryClient]);

  const { data: yearsData } = useAcademicYears();

  useEffect(() => {
    if (!academicYearId && yearsData?.current) setAcademicYearId(yearsData.current.id);
  }, [yearsData, academicYearId]);

  const { data: teachers } = useQuery({
    queryKey: ['teachers'],
    queryFn: () => listTeachers(),
    staleTime: 5 * 60_000,
  });

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

  const { data: assignmentsData, isLoading, error, refetch } = useQuery({
    queryKey: ['assignments', 'all', academicYearId, teacherId],
    queryFn: () =>
      listAssignments({ academicYearId, teacherId: teacherId || undefined }),
    enabled: Boolean(academicYearId),
  });

  const create = useCrudMutation<
    TeacherAssignment,
    {
      teacherId: string;
      academicYearId: string;
      sectionId: string;
      subjectId: string;
      classId: string;
    }
  >({
    mutationFn: (values) => createAssignment(values),
    invalidates: [['assignments']],
    successMessage: 'Assignment created',
    onSuccess: () => setCreateOpen(false),
  });

  const remove = useCrudMutation<void, string>({
    mutationFn: (id) => deleteAssignment(id),
    invalidates: [['assignments']],
    // Two-line toast: the second sentence is the reassurance an administrator
    // needs before they click, so it is not collapsed into a generic success.
    onSuccess: () =>
      success('Assignment removed', 'The teacher no longer has access to that sheet.'),
  });

  const classSectionsList = classSections ?? [];
  const selectedClassId = classSectionsList.find((entry) => entry.sectionId === sectionId)?.classId;

  const assignments = assignmentsData ?? [];
  const canSubmit = Boolean(teacherId && sectionId && subjectId && academicYearId);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">
            Who may enter marks for which class, section and subject.
          </h1>
        </div>
        <Button
          variant="primary"
          icon={<IconPlus size={16} />}
          onClick={() => setCreateOpen(true)}
          disabled={!academicYearId}
        >
          Assign teacher
        </Button>
      </header>

      <Alert tone="info" title="This is how access is granted">
        A teacher can only open, edit and submit mark sheets for an explicit assignment. Removing an
        assignment removes that access immediately — the server re-checks on every request.
      </Alert>

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Academic year"
            value={academicYearId}
            onChange={(event) => setAcademicYearId(event.target.value)}
            options={(yearsData?.academicYears ?? []).map((year) => ({ value: year.id, label: year.name }))}
            placeholder="Select a year"
          />
          <Select
            label="Filter by teacher"
            value={teacherId}
            onChange={(event) => setTeacherId(event.target.value)}
            options={[
              { value: '', label: 'All teachers' },
              ...(teachers ?? []).map((teacher) => ({
                value: teacher.id,
                label: `${teacher.fullName} (${teacher.email})`,
              })),
            ]}
          />
        </div>
      </Card>

      <Card flush>
        {isLoading && <LoadingState label="Loading assignments…" />}
        {error instanceof QueryError && (
          <div className="p-5">
            <ErrorState message={error.userMessage} onRetry={() => void refetch()} />
          </div>
        )}
        {!isLoading && assignments.length === 0 && (
          <div className="p-5">
            <EmptyState
              title="No assignments"
              description="Without an assignment, a teacher sees no classes and cannot enter marks."
              icon="🔗"
            />
          </div>
        )}

        {assignments.length > 0 && (
          <Table caption="Teacher assignments">
            <THead>
              <tr>
                <TH>Teacher</TH>
                <TH>Class</TH>
                <TH>Subject</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </tr>
            </THead>
            <TBody>
              {assignments.map((assignment) => (
                <TR key={assignment.id}>
                  <TD>
                    <p className="font-medium text-ink">{assignment.teacherName}</p>
                    <p className="truncate text-xs text-ink-subtle">{assignment.teacherEmail}</p>
                  </TD>
                  <TD className="whitespace-nowrap text-ink">
                    Class {assignment.className}
                    <Badge className="ml-1.5">{assignment.sectionName}</Badge>
                  </TD>
                  <TD>
                    <Badge tone="accent">{assignment.subjectCode}</Badge>
                    <span className="ml-1.5 text-ink">{assignment.subjectName}</span>
                  </TD>
                  <TD>
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={remove.isPending}
                        onClick={() => remove.mutate(assignment.id)}
                      >
                        Remove
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {/* Create */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Assign a teacher"
        description="Grant access to one class, section and subject."
        busy={create.isPending}
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={!canSubmit}
              onClick={() =>
                create.mutate({
                  teacherId,
                  academicYearId,
                  sectionId,
                  subjectId,
                  classId: selectedClassId ?? '',
                })
              }
            >
              Create assignment
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {create.fieldError && <Alert tone="danger">{create.fieldError}</Alert>}

          <Select
            label="Teacher"
            value={teacherId}
            onChange={(event) => setTeacherId(event.target.value)}
            options={(teachers ?? []).map((teacher) => ({
              value: teacher.id,
              label: `${teacher.fullName} (${teacher.email})`,
            }))}
            placeholder="Select a teacher"
            required
          />

          <Select
            label="Class & section"
            value={sectionId}
            onChange={(event) => setSectionId(event.target.value)}
            options={classSectionsList.map((entry) => ({
              value: entry.sectionId,
              label: `Class ${entry.className} · Section ${entry.sectionName}`,
            }))}
            placeholder="Select a section"
            required
          />

          <Select
            label="Subject"
            value={subjectId}
            onChange={(event) => setSubjectId(event.target.value)}
            options={(subjects ?? []).map((subject) => ({
              value: subject.id,
              label: `${subject.code} · ${subject.name}`,
            }))}
            placeholder="Select a subject"
            required
          />

          {!canSubmit && (
            <Alert tone="info">
              Complete every selection to create the assignment.
            </Alert>
          )}
        </div>
      </Modal>
    </div>
  );
}
