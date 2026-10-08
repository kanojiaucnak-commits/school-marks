import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/ui/Toast';
import StudentsPage from './StudentsPage';

/**
 * Opening the enrolment dialog must not throw.
 *
 * `AddStudentDialog` seeds its optional fields with `null` — which is what the
 * database columns are — and hands a `setValueAs` to react-hook-form for each
 * one. react-hook-form runs every `setValueAs` back over the field's default
 * value as the input mounts, so those callbacks receive `null` on the very first
 * frame. Both of them called `.trim()` unconditionally, which threw
 * `Cannot read properties of null (reading 'trim')` during commit and took the
 * whole route down with it.
 *
 * It had never been seen because the dialog is gated on an academic year, and
 * the database had none. Creating the first one made *Add student* clickable
 * for the first time, and the first click crashed the page.
 */

vi.mock('../../lib/auth', async () => {
  const { PERMISSIONS } = await import('@school/shared');
  return {
    useAuth: () => ({
      user: {
        id: 'user_test',
        email: 'admin@example.test',
        fullName: 'Test Admin',
        username: null,
        role: 'role_admin',
        employeeCode: null,
        phone: null,
        status: 'active',
        permissions: [
          PERMISSIONS.STUDENT_VIEW,
          PERMISSIONS.STUDENT_VIEW_ALL,
          PERMISSIONS.STUDENT_CREATE,
          PERMISSIONS.STUDENT_IMPORT,
          PERMISSIONS.MARKS_VIEW_ALL,
        ],
        mustChangePassword: false,
        lastLoginAt: null,
      },
    }),
  };
});

const YEAR = {
  id: 'year_1',
  name: '2026-2027',
  startDate: '2026-04-01',
  endDate: '2027-03-31',
  isCurrent: true,
  status: 'active',
  createdAt: '2026-10-08T00:00:00Z',
  updatedAt: '2026-10-08T00:00:00Z',
};

vi.mock('../../lib/repos/academic', () => ({
  listAcademicYears: async () => [YEAR],
  getCurrentAcademicYear: async () => YEAR,
  listClasses: async () => ({ classes: [], sections: [] }),
  listClassSections: async () => [],
  listAssignments: async () => [],
}));

vi.mock('../../lib/repos/students', () => ({
  listStudents: async () => ({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 }),
  createStudent: async (values: unknown) => values,
}));

vi.mock('../../lib/repos/storage', () => ({
  downloadStudentExport: async () => 'blob:mock-export',
  downloadFromUrl: async () => undefined,
}));

function renderStudentsPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <StudentsPage />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('Students — Add student dialog', () => {
  it('opens without throwing when the optional fields default to null', async () => {
    const user = userEvent.setup();

    renderStudentsPage();

    // Both the header and the empty state offer it; the header one is enough.
    const buttons = await screen.findAllByRole('button', { name: 'Add student' });
    await user.click(buttons[0]!);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Full name')).toBeInTheDocument();

    // The optional fields must still be empty rather than coerced into data
    // the database would have to store. The roll number is read straight off the
    // element because jest-dom reports an empty `type="number"` input as `null`.
    expect(screen.getByLabelText(/Admission number/)).toHaveValue('');
    expect((screen.getByLabelText(/Roll number/) as HTMLInputElement).value).toBe('');
  });
});
