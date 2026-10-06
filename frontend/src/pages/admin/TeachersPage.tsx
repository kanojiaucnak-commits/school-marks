import { useCallback, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { createUserSchema, type Role, type User, type UserListItem } from '@school/shared';
import { QueryError } from '../../lib/query';
import {
  deactivateUser,
  listUsers,
  provisionUser,
  updateUser,
} from '../../lib/repos/admin';
import { roleLabel } from '../../lib/permissions';
import { formatDateTime, pluralise } from '../../lib/utils';
import { Badge, ToneBadge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Select, TextInput } from '../../components/ui/Field';
import { Card, Pagination, Table, TBody, TD, TH, THead, TR } from '../../components/ui/Table';
import { Alert, EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { ConfirmDialog, Modal } from '../../components/ui/Modal';
import { useListQuery, type ListParams } from '../../hooks/useListQuery';
import { useCrudMutation } from '../../components/admin/useCrudMutation';
import { IconKey, IconPlus, IconTrash } from '../../components/ui/icons';

/**
 * Fields this screen can actually write.
 *
 * The shared schema carries `password` and `mustChangePassword`, which belonged
 * to the admin-issued temporary-password flow. Clerk owns credentials now, and the
 * user sets their own password on first sign-in, so those fields are dropped
 * rather than silently accepted and ignored. `sendInvite` is kept: the Edge
 * Function can ask Clerk to email an invitation, which is still the smoothest path
 * to a first sign-in.
 */
const provisionUserSchema = createUserSchema.omit({
  password: true,
  mustChangePassword: true,
});
type ProvisionUserInput = z.infer<typeof provisionUserSchema>;

type UserPatch = Partial<Pick<User, 'fullName' | 'role' | 'status' | 'employeeCode' | 'phone'>>;

/**
 * Teacher and staff management.
 *
 * Accounts live in Clerk; this screen writes the `profiles` row that gives a
 * Clerk account a role, employee code and status. Nothing here can create the
 * sign-in itself.
 */
export default function TeachersPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<UserListItem | null>(null);
  const [deactivating, setDeactivating] = useState<UserListItem | null>(null);
  const [provisioned, setProvisioned] = useState<{ email: string; fullName: string } | null>(null);

  const fetcher = useCallback((params: ListParams) => listUsers(params), []);

  const list = useListQuery<UserListItem>({ key: ['users'], fetcher });

  const [roleFilter, setRoleFilter] = useState('');

  const create = useCrudMutation<User, ProvisionUserInput>({
    mutationFn: (values) =>
      provisionUser({
        email: values.email,
        fullName: values.fullName,
        role: values.role,
        employeeCode: values.employeeCode ?? null,
        phone: values.phone ?? null,
        sendInvite: values.sendInvite,
      }),
    invalidates: [['users']],
    successMessage: 'User added to the school',
    onSuccess: (data) => {
      setCreateOpen(false);
      setProvisioned({ email: data.email, fullName: data.fullName });
    },
  });

  const update = useCrudMutation<User, UserPatch & { id: string }>({
    mutationFn: ({ id, ...patch }) => updateUser(id, patch),
    invalidates: [['users']],
    successMessage: 'User updated',
    onSuccess: () => setEditing(null),
  });

  const setStatus = useCrudMutation<void, string>({
    mutationFn: (id) => deactivateUser(id),
    invalidates: [['users']],
    successMessage: 'User deactivated',
    onSuccess: () => setDeactivating(null),
  });

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">
            Accounts, roles and access. A teacher only reaches the classes assigned to them.
          </h1>
        </div>
        <Button variant="primary" icon={<IconPlus size={16} />} onClick={() => setCreateOpen(true)}>
          Add user
        </Button>
      </header>

      {/* Confirm the profile was written, since no password is issued any more. */}
      {provisioned && (
        <Alert tone="info" title="School profile created" onDismiss={() => setProvisioned(null)}>
          <p>
            <strong>{provisioned.fullName}</strong> can now sign in as{' '}
            <strong>{provisioned.email}</strong>. Sign-in is handled by Clerk, so there is no
            password to hand over — they set their own on first sign-in.
          </p>
        </Alert>
      )}

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <label htmlFor="user-search" className="block text-sm font-medium text-ink">
              Search
            </label>
            <input
              id="user-search"
              type="search"
              value={list.searchInput}
              onChange={(event) => list.setSearchInput(event.target.value)}
              placeholder="Name, email or employee code"
              className="mt-1.5 h-10 w-full rounded-lg border border-line-strong px-3 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
            />
          </div>

          <Select
            label="Role"
            value={roleFilter}
            onChange={(event) => list.setFilter('role', event.target.value || undefined)}
            options={[
              { value: '', label: 'All roles' },
              { value: 'teacher', label: 'Teacher' },
              { value: 'reviewer', label: 'Reviewer / Principal' },
              { value: 'admin', label: 'Administrator' },
            ]}
          />

          <Select
            label="Status"
            value={(list.filters.status as string) ?? ''}
            onChange={(event) => list.setFilter('status', event.target.value || undefined)}
            options={[
              { value: '', label: 'All' },
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
            ]}
          />
        </div>
      </Card>

      <Card flush>
        {list.isLoading && <LoadingState label="Loading users…" />}

        {list.error instanceof QueryError && (
          <div className="p-5">
            <ErrorState message={list.error.userMessage} onRetry={() => void list.refetch()} />
          </div>
        )}

        {list.isEmpty && (
          <div className="p-5">
            <EmptyState title="No users found" icon="👤" />
          </div>
        )}

        {list.items.length > 0 && (
          <>
            <Table caption="Users">
              <THead>
                <tr>
                  <TH>Name</TH>
                  <TH>Role</TH>
                  <TH>Employee code</TH>
                  <TH>Last sign-in</TH>
                  <TH>Status</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {list.items.map((user) => (
                  <TR key={user.id}>
                    <TD>
                      <p className="font-medium text-ink">{user.fullName}</p>
                      <p className="truncate text-xs text-ink-subtle">{user.email}</p>
                    </TD>
                    <TD className="whitespace-nowrap text-ink">{roleLabel(user.role)}</TD>
                    <TD className="tabular text-ink-muted">{user.employeeCode ?? '—'}</TD>
                    <TD className="tabular whitespace-nowrap text-ink-muted">
                      {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Never'}
                    </TD>
                    <TD>
                      {user.status === 'active' ? (
                        <ToneBadge tone="success">Active</ToneBadge>
                      ) : (
                        <ToneBadge tone="neutral">Inactive</ToneBadge>
                      )}
                      {user.mustChangePassword && (
                        <Badge className="ml-1.5 bg-warning-50 text-warning-800 ring-warning-300">
                          Must reset
                        </Badge>
                      )}
                    </TD>
                    <TD>
                      <div className="flex justify-end gap-1.5">
                        <Button size="sm" onClick={() => setEditing(user)}>
                          Edit
                        </Button>
                        {user.status === 'active' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<IconTrash size={14} />}
                            onClick={() => setDeactivating(user)}
                            aria-label={`Deactivate ${user.fullName}`}
                          >
                            Deactivate
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
              extra={<p className="text-xs text-ink-subtle">{pluralise(list.total, 'user')}</p>}
            />
          </>
        )}
      </Card>

      {/* Create */}
      <CreateUserDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        pending={create.isPending}
        error={create.fieldError}
        onSubmit={(values) => create.mutate(values)}
      />

      {/* Edit */}
      {editing && (
        <EditUserDialog
          user={editing}
          onClose={() => setEditing(null)}
          pending={update.isPending}
          error={update.fieldError}
          onSubmit={(values) => update.mutate({ id: editing.id, ...values })}
        />
      )}

      <ConfirmDialog
        open={Boolean(deactivating)}
        onCancel={() => setDeactivating(null)}
        onConfirm={() => deactivating && setStatus.mutate(deactivating.id)}
        busy={setStatus.isPending}
        tone="danger"
        title={`Deactivate ${deactivating?.fullName}?`}
        confirmLabel="Deactivate"
        message={
          <div className="space-y-2">
            <p>
              They will be signed out immediately and will no longer be able to sign in. Their
              historical marks and submissions are kept.
            </p>
            <p className="text-ink-muted">
              Any classes assigned only to them will need a new teacher.
            </p>
          </div>
        }
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Create dialog                                                               */
/* -------------------------------------------------------------------------- */

function CreateUserDialog({
  open,
  onClose,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  pending: boolean;
  error: string | null;
  onSubmit: (values: ProvisionUserInput) => void;
}) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ProvisionUserInput>({
    resolver: zodResolver(provisionUserSchema),
    defaultValues: {
      email: '',
      fullName: '',
      role: 'teacher',
      sendInvite: true,
    },
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Add a user"
      description="Creates the sign-in account and the school's profile for it in one step. The user sets their own password on first sign-in."
      busy={pending}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            onClick={handleSubmit((values) => onSubmit(values))}
          >
            Create user
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit((values) => onSubmit(values))();
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}

        <TextInput
          label="Full name"
          autoComplete="name"
          error={errors.fullName?.message}
          {...register('fullName')}
        />

        <TextInput
          label="Email address"
          type="email"
          autoComplete="email"
          error={errors.email?.message}
          {...register('email')}
        />

        <Select
          label="Role"
          error={errors.role?.message}
          options={[
            { value: 'teacher', label: 'Teacher' },
            { value: 'reviewer', label: 'Reviewer / Principal' },
            { value: 'admin', label: 'Administrator' },
          ]}
          {...register('role')}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput
            label="Employee code (optional)"
            error={errors.employeeCode?.message}
            {...register('employeeCode')}
          />
          <TextInput
            label="Phone (optional)"
            type="tel"
            error={errors.phone?.message}
            {...register('phone')}
          />
        </div>
      </form>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Edit dialog                                                                 */
/* -------------------------------------------------------------------------- */

function EditUserDialog({
  user,
  onClose,
  pending,
  error,
  onSubmit,
}: {
  user: UserListItem;
  onClose: () => void;
  pending: boolean;
  error: string | null;
  onSubmit: (values: UserPatch) => void;
}) {
  const [role, setRole] = useState<Role>(user.role);

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${user.fullName}`}
      description={user.email}
      busy={pending}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            onClick={() =>
              onSubmit({
                fullName: user.fullName,
                role,
                employeeCode: user.employeeCode ?? undefined,
              })
            }
          >
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}

        <Alert tone="info">
          Changing a role signs the user out so their new permissions take effect immediately.
        </Alert>

        <Select
          label="Role"
          value={role}
          onChange={(event) => setRole(event.target.value as Role)}
          options={[
            { value: 'teacher', label: 'Teacher' },
            { value: 'reviewer', label: 'Reviewer / Principal' },
            { value: 'admin', label: 'Administrator' },
          ]}
        />

        <TextInput label="Full name" defaultValue={user.fullName} readOnly />
        <TextInput label="Employee code" defaultValue={user.employeeCode ?? ''} readOnly />
      </div>
    </Modal>
  );
}
