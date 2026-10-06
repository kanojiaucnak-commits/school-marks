import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClassRecord, Section } from '@school/shared';
import { QueryError } from '../../lib/query';
import {
  createClass,
  createSection,
  deleteSection,
  deleteClass,
  listClasses,
  listClassSections,
  updateClass,
  updateSection,
} from '../../lib/repos/academic';
import { pluralise } from '../../lib/utils';
import { Button } from '../../components/ui/Button';
import { Select, TextInput } from '../../components/ui/Field';
import { Card } from '../../components/ui/Table';
import { Alert, EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { Modal } from '../../components/ui/Modal';
import { useCrudMutation } from '../../components/admin/useCrudMutation';
import { useAcademicYears } from '../../hooks/useAcademicYears';
import { IconEdit, IconPlus, IconTrash } from '../../components/ui/icons';

/**
 * Classes and sections.
 *
 * Both belong to a single academic year, so switching years switches the whole
 * tree. Deleting a class cascades to its sections, which is why the confirm
 * dialog spells that out — and the foreign keys refuse it outright if any of
 * those sections still hold students or marks.
 */
export default function ClassesPage() {
  const queryClient = useQueryClient();

  const [academicYearId, setAcademicYearId] = useState('');
  const [classOpen, setClassOpen] = useState(false);
  const [sectionOpen, setSectionOpen] = useState<ClassRecord | null>(null);
  const [editingClass, setEditingClass] = useState<ClassRecord | null>(null);
  const [editingSection, setEditingSection] = useState<Section | null>(null);
  const [deletingSection, setDeletingSection] = useState<Section | null>(null);
  const [deletingClass, setDeletingClass] = useState<ClassRecord | null>(null);

  const { data: yearsData } = useAcademicYears();

  useEffect(() => {
    if (!academicYearId && yearsData?.current) setAcademicYearId(yearsData.current.id);
  }, [yearsData, academicYearId]);

  const { data, isLoading, error, refetch } = useQuery<{
    classes: ClassRecord[];
    sections: Section[];
  }>({
    queryKey: ['classes', academicYearId],
    queryFn: () => listClasses(academicYearId),
    enabled: Boolean(academicYearId),
  });

  const { data: classSections } = useQuery({
    queryKey: ['class-sections', academicYearId],
    queryFn: () => listClassSections(academicYearId),
    enabled: Boolean(academicYearId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['classes'] });
    void queryClient.invalidateQueries({ queryKey: ['class-sections'] });
  };

  const createClassMutation = useCrudMutation<
    ClassRecord,
    { academicYearId: string; name: string; level?: number | null }
  >({
    mutationFn: (values) => createClass(values),
    onSuccess: () => {
      invalidate();
      setClassOpen(false);
    },
    successMessage: 'Class created',
  });

  const createSectionMutation = useCrudMutation<Section, { classId: string; name: string }>({
    mutationFn: (values) => createSection(values),
    onSuccess: () => {
      invalidate();
      setSectionOpen(null);
    },
    successMessage: 'Section created',
  });

  /**
   * Rename a class.
   *
   * `updateClass` existed in the repository and was called from nowhere, so a mistyped
   * class name could only be worked around by deleting the class — which takes every
   * student in it with it, because `students.class_id` is ON DELETE RESTRICT. The same
   * dead-end the section rename below was written to close.
   */
  const renameClass = useCrudMutation<ClassRecord, { id: string; name: string }>({
    mutationFn: ({ id, name }) => updateClass(id, { name }),
    onSuccess: () => {
      invalidate();
      setEditingClass(null);
    },
    successMessage: 'Class renamed',
  });

  /**
   * Rename and remove a section.
   *
   * Both existed in the repository with no way to reach them, so a mistyped section
   * name could only be worked around by deleting and recreating the class — which
   * would take its students with it.
   */
  const renameSection = useCrudMutation<Section, { id: string; name: string; classTeacherId: string | null }>({
    mutationFn: ({ id, name, classTeacherId }) => updateSection(id, { name, classTeacherId }),
    onSuccess: () => {
      invalidate();
      setEditingSection(null);
    },
    successMessage: 'Section updated',
  });

  const removeSection = useCrudMutation<void, string>({
    mutationFn: (id) => deleteSection(id),
    onSuccess: () => {
      invalidate();
      setDeletingSection(null);
    },
    successMessage: 'Section deleted',
  });

  const removeClass = useCrudMutation<void, string>({
    mutationFn: (id) => deleteClass(id),
    onSuccess: () => {
      invalidate();
      setDeletingClass(null);
    },
    successMessage: 'Class deleted',
  });

  const classes = data?.classes ?? [];
  const sections = data?.sections ?? [];

  const sectionsByClass = useMemo(() => {
    const map = new Map<string, Section[]>();
    for (const section of sections) {
      const list = map.get(section.classId) ?? [];
      list.push(section);
      map.set(section.classId, list);
    }
    return map;
  }, [sections]);

  const studentCountBySection = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of classSections ?? []) {
      map.set(entry.sectionId, entry.studentCount);
    }
    return map;
  }, [classSections]);

  /**
   * Students per class, summed over that class's sections.
   *
   * Needed to warn before a delete is attempted rather than after. Both
   * `students.class_id` and `students.section_id` are ON DELETE RESTRICT, so a class or
   * section holding any student — marked or not — cannot be deleted at all. Saying so up
   * front turns a round trip and an error into a sentence the reader can act on.
   */
  const studentCountByClass = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of classSections ?? []) {
      map.set(entry.classId, (map.get(entry.classId) ?? 0) + entry.studentCount);
    }
    return map;
  }, [classSections]);

  const studentCount = (record: ClassRecord | null) =>
    record ? (studentCountByClass.get(record.id) ?? 0) : 0;

  const sectionCount = (record: ClassRecord | null) =>
    record ? (sectionsByClass.get(record.id)?.length ?? 0) : 0;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="page-title">
          Students belong to a section within a class, for a specific academic year.
        </h1>
      </header>

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Select
            label="Academic year"
            value={academicYearId}
            onChange={(event) => setAcademicYearId(event.target.value)}
            options={(yearsData?.academicYears ?? []).map((year) => ({ value: year.id, label: year.name }))}
            placeholder="Select a year"
          />
          <div className="flex items-end">
            <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setClassOpen(true)}>
              Add class
            </Button>
          </div>
        </div>
      </Card>

      {!academicYearId && <Alert tone="info">Choose an academic year to see its classes.</Alert>}

      {isLoading && <LoadingState label="Loading classes…" />}

      {error instanceof QueryError && (
        <ErrorState message={error.userMessage} onRetry={() => void refetch()} />
      )}

      {academicYearId && !isLoading && classes.length === 0 && (
        <EmptyState
          title="No classes for this year"
          description="Create a class (for example 9, 10 or 11), then add its sections."
          icon="🏫"
        />
      )}

      {classes.length > 0 && (
        <div className="space-y-3">
          {classes.map((classRecord) => {
            const classSectionsList = sectionsByClass.get(classRecord.id) ?? [];
            return (
              <Card key={classRecord.id} flush>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4">
                  <div>
                    <h2 className="font-semibold text-ink">Class {classRecord.name}</h2>
                    <p className="tabular text-xs text-ink-subtle">
                      {pluralise(classSectionsList.length, 'section')}
                      {classRecord.level !== null && ` · level ${classRecord.level}`}
                    </p>
                  </div>
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      icon={<IconPlus size={14} />}
                      onClick={() => setSectionOpen(classRecord)}
                    >
                      Add section
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingClass(classRecord)}
                      aria-label={`Rename class ${classRecord.name}`}
                    >
                      <IconEdit size={14} />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeletingClass(classRecord)}>
                      Delete
                    </Button>
                  </div>
                </div>

                {classSectionsList.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-ink-subtle">
                    No sections yet. Students must belong to a section.
                  </p>
                ) : (
                  <ul className="divide-y divide-line-soft">
                    {classSectionsList.map((section) => (
                      <li key={section.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                        <span className="text-sm font-medium text-ink">
                          Section {section.name}
                        </span>
                        <div className="flex items-center gap-3">
                          <span className="tabular text-xs text-ink-subtle">
                            {studentCountBySection.get(section.id) ?? 0} students
                          </span>
                          <Button
                            variant="ghost"
                            onClick={() => setEditingSection(section)}
                            aria-label={`Rename section ${section.name}`}
                          >
                            <IconEdit size={16} />
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => setDeletingSection(section)}
                            aria-label={`Delete section ${section.name}`}
                          >
                            <IconTrash size={16} />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Create class */}
      <Modal
        open={classOpen}
        onClose={() => setClassOpen(false)}
        title="Add a class"
        busy={createClassMutation.isPending}
        footer={
          <>
            <Button onClick={() => setClassOpen(false)} disabled={createClassMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={createClassMutation.isPending}
              onClick={() =>
                (document.getElementById('class-form') as HTMLFormElement | null)?.requestSubmit()
              }
            >
              Create class
            </Button>
          </>
        }
      >
        <NameForm
          formId="class-form"
          label="Class name"
          placeholder="10"
          hint="Usually a grade number or name, e.g. 10 or Senior 2."
          error={createClassMutation.fieldError}
          onSubmit={(name) => createClassMutation.mutate({ academicYearId, name })}
          disabled={!academicYearId}
        />
      </Modal>

      {/* Create section */}
      <Modal
        open={Boolean(sectionOpen)}
        onClose={() => setSectionOpen(null)}
        title={`Add a section to class ${sectionOpen?.name ?? ''}`}
        busy={createSectionMutation.isPending}
        footer={
          <>
            <Button onClick={() => setSectionOpen(null)} disabled={createSectionMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={createSectionMutation.isPending}
              onClick={() =>
                (document.getElementById('section-form') as HTMLFormElement | null)?.requestSubmit()
              }
            >
              Create section
            </Button>
          </>
        }
      >
        <NameForm
          formId="section-form"
          label="Section name"
          placeholder="A"
          hint="Usually a single letter, e.g. A, B or C."
          error={createSectionMutation.fieldError}
          onSubmit={(name) =>
            sectionOpen && createSectionMutation.mutate({ classId: sectionOpen.id, name })
          }
        />
      </Modal>

      {/* Rename class */}
        <Modal
          open={Boolean(editingClass)}
          onClose={() => setEditingClass(null)}
          title={`Rename class ${editingClass?.name ?? ''}`}
          busy={renameClass.isPending}
          footer={
            <>
              <Button onClick={() => setEditingClass(null)} disabled={renameClass.isPending}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={renameClass.isPending}
                onClick={() =>
                  (document.getElementById('class-rename-form') as HTMLFormElement | null)?.requestSubmit()
                }
              >
                Save name
              </Button>
            </>
          }
        >
          <NameForm
            formId="class-rename-form"
            label="Class name"
            placeholder="Grade 6"
            hint="Shown on reports and exports. Renaming does not move students between classes."
            initial={editingClass?.name ?? ''}
            error={renameClass.fieldError}
            onSubmit={(name) => editingClass && renameClass.mutate({ id: editingClass.id, name })}
          />
        </Modal>

        {/* Rename section */}
      <Modal
        open={Boolean(editingSection)}
        onClose={() => setEditingSection(null)}
        title={`Edit section ${editingSection?.name ?? ''}`}
        busy={renameSection.isPending}
        footer={
          <>
            <Button onClick={() => setEditingSection(null)} disabled={renameSection.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={renameSection.isPending}
              onClick={() =>
                (document.getElementById('section-rename-form') as HTMLFormElement | null)?.requestSubmit()
              }
            >
              Save name
            </Button>
          </>
        }
      >
        <SectionEditForm
          formId="section-rename-form"
          initialName={editingSection?.name ?? ''}
          initialClassTeacherId={editingSection?.classTeacherId ?? null}
          error={renameSection.fieldError}
          onSubmit={(name, classTeacherId) =>
            editingSection && renameSection.mutate({ id: editingSection.id, name, classTeacherId })
          }
        />
      </Modal>

      {/* Delete section */}
      <Modal
        open={Boolean(deletingSection)}
        onClose={() => setDeletingSection(null)}
        title={`Delete section ${deletingSection?.name ?? ''}?`}
        busy={removeSection.isPending}
        footer={
          <>
            <Button onClick={() => setDeletingSection(null)} disabled={removeSection.isPending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={removeSection.isPending}
              onClick={() => deletingSection && removeSection.mutate(deletingSection.id)}
            >
              Delete section
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {deletingSection && studentCountBySection.get(deletingSection.id) ? (
            <Alert tone="danger">
              {pluralise(
                studentCountBySection.get(deletingSection.id) ?? 0,
                'student',
              )}{' '}
              {studentCountBySection.get(deletingSection.id) === 1 ? 'is' : 'are'} still in this
              section. The database refuses to delete a section that holds students, so this will
              not go through — and no marks are lost. Move or{' '}
              {studentCountBySection.get(deletingSection.id) === 1 ? 'delete that student' : 'delete those students'}{' '}
              first.
            </Alert>
          ) : (
            <Alert tone="danger" title="This section is empty and can be deleted">
              If it was only misnamed, cancel and rename it instead.
            </Alert>
          )}
          {removeSection.fieldError && (
            <Alert tone="danger">{removeSection.fieldError}</Alert>
          )}
        </div>
      </Modal>

      {/* Delete class */}
      <Modal
        open={Boolean(deletingClass)}
        onClose={() => setDeletingClass(null)}
        title={`Delete class ${deletingClass?.name ?? ''}?`}
        description="This also deletes every section in the class."
        busy={removeClass.isPending}
        footer={
          <>
            <Button onClick={() => setDeletingClass(null)} disabled={removeClass.isPending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={removeClass.isPending}
              onClick={() => deletingClass && removeClass.mutate(deletingClass.id)}
            >
              Delete class
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {deletingClass && studentCount(deletingClass) > 0 ? (
            <Alert tone="danger">
              {pluralise(studentCount(deletingClass), 'student')} are still in this class. The
              database refuses to delete a class that holds students, whether or not they have
              marks, so this will not go through. Move or delete{' '}
              {studentCount(deletingClass) === 1 ? 'that student' : 'those students'} first.
            </Alert>
          ) : (
            <Alert tone="danger">
              This deletes the class and all {pluralise(sectionCount(deletingClass), 'section')} in
              it. Any pending class request for it goes too.
            </Alert>
          )}
          {removeClass.fieldError && <Alert tone="danger">{removeClass.fieldError}</Alert>}
        </div>
      </Modal>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function NameForm({
  formId,
  label,
  placeholder,
  hint,
  onSubmit,
  error,
  disabled,
  initial = '',
}: {
  formId: string;
  label: string;
  placeholder: string;
  hint: string;
  onSubmit: (name: string) => void;
  error: string | null;
  disabled?: boolean;
  /** Seeds the field when renaming an existing record. */
  initial?: string;
}) {
  // Keyed by formId so the field resets when the modal is reused for a different
  // record — without it, renaming section B after A would still show A.
  const [name, setName] = useState(initial);
  const trimmed = name.trim();

  return (
    <form
      id={formId}
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!trimmed) return;
        onSubmit(trimmed);
        setName('');
      }}
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {disabled && <Alert tone="warning">Choose an academic year first.</Alert>}

      <TextInput
        label={label}
        placeholder={placeholder}
        hint={hint}
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />
    </form>
  );
}

/** Name plus the class teacher for a section. */
function SectionEditForm({
  formId,
  initialName,
  initialClassTeacherId,
  error,
  onSubmit,
}: {
  formId: string;
  initialName: string;
  initialClassTeacherId: string | null;
  error: string | null;
  onSubmit: (name: string, classTeacherId: string | null) => void;
}) {
  const [name, setName] = useState(initialName);
  const [classTeacherId, setClassTeacherId] = useState(initialClassTeacherId ?? '');
  const [teachers, setTeachers] = useState<Array<{ id: string; label: string }>>([]);

  useEffect(() => {
    let cancelled = false;
    import('../../lib/repos/admin')
      .then(({ listTeachers }) => listTeachers())
      .then((rows) => {
        if (!cancelled) {
          setTeachers(rows.map((row) => ({ id: row.id, label: row.fullName ?? row.email ?? 'Teacher' })));
        }
      })
      .catch(() => {
        /* the dropdown stays empty; name edit still works */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmed = name.trim();

  return (
    <form
      id={formId}
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!trimmed) return;
        onSubmit(trimmed, classTeacherId || null);
      }}
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <TextInput
        label="Section name"
        placeholder="A"
        hint="Usually a single letter, e.g. A, B or C."
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />

      <Select
        label="Class teacher"
        value={classTeacherId}
        onChange={(event) => setClassTeacherId(event.target.value)}
        options={[{ value: '', label: 'None' }, ...teachers.map((row) => ({ value: row.id, label: row.label }))]}
        hint="Can enter marks for every subject in this section."
      />
    </form>
  );
}
