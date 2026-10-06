import type {
  AuditLogEntry,
  MarkSubmission,
  Role,
  User,
  UserListItem,
} from '@school/shared';
import { useQueryClient } from '@tanstack/react-query';
import { getSupabase } from '../supabase';
import { edgeFetch } from '../edge';
import {
  applySearch,
  camel,
  camelMany,
  orSearch,
  paginate,
  toQueryError,
  type ListParams,
  type ListResponse,
} from '../query';

/**
 * Users, audit log, notifications and settings.
 *
 * User accounts live in Clerk; `profiles` holds the school-specific record.
 * Creating a user therefore spans two systems — see `provisionUser()`.
 */

/* -------------------------------------------------------------------------- */
/* Users                                                                        */
/* -------------------------------------------------------------------------- */

export async function listUsers(params: ListParams): Promise<ListResponse<UserListItem>> {
  const { page, pageSize, role, status, search } = params;

  let q = getSupabase().from('v_directory').select('*', { count: 'exact' });

  if (role) q = q.eq('role', role);
  if (status) q = q.eq('status', status);
  q = applySearch(q, orSearch(['full_name', 'email', 'employee_code'], search as string | undefined));

  return paginate<UserListItem, typeof q>(q.order('full_name'), {
    page: page as number,
    pageSize: pageSize as number,
  });
}

export async function getUser(id: string): Promise<UserListItem | null> {
  const { data, error } = await getSupabase().from('v_directory').select('*').eq('id', id).maybeSingle();
  if (error) throw toQueryError(error);
  return camel<UserListItem>(data);
}

/** Active teachers, for the assignment picker. */
export async function listTeachers(): Promise<Array<Pick<User, 'id' | 'fullName' | 'email'>>> {
  const { data, error } = await getSupabase()
    .from('v_directory')
    .select('id, full_name, email')
    .eq('role', 'teacher')
    .eq('status', 'active')
    .order('full_name');

  if (error) throw toQueryError(error);
  return camelMany<Pick<User, 'id' | 'fullName' | 'email'>>(data);
}

/**
 * Create a user account.
 *
 * Calls the `admin-create-clerk-user` Edge Function rather than writing
 * `profiles` directly, because creating the Clerk identity needs the **secret
 * key** — which must never be in the browser bundle. The function creates the
 * Clerk user, then provisions the profile, rolling the account back if the second
 * step fails so no un-provisioned account is left behind.
 *
 * This is the admin-created path, where the `handle_new_user()` trigger's default
 * of `role_teacher` is not necessarily what the administrator chose. Teachers who
 * sign themselves up never come through here: `provision_current_profile()`
 * provisions those on first authenticated request.
 *
 * Requires `user:create` (admin only), which the function re-checks.
 */
export async function provisionUser(input: {
  email: string;
  fullName: string;
  role: Role;
  employeeCode?: string | null;
  phone?: string | null;
  sendInvite?: boolean;
}): Promise<User> {
  const result = await edgeFetch<{ profile: Record<string, unknown>; clerkUserId: string }>(
    'admin-create-clerk-user',
    {
      method: 'POST',
      body: input,
    },
  );

  return camel<User>(result.profile)!;
}

/**
 * Update the signed-in user's own school profile.
 *
 * Only the school-specific fields are writable here — name, phone, employee code.
 * Role and status are deliberately excluded: a user editing their own row must not
 * be able to promote themselves. A database trigger enforces that too, but not
 * offering the field at all removes the possibility rather than relying on it.
 */
export async function updateOwnProfile(
  queryClient: ReturnType<typeof useQueryClient>,
  patch: Partial<Pick<User, 'fullName' | 'phone' | 'employeeCode'>>,
): Promise<User> {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    row[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = value;
  }

  const { data, error } = await getSupabase()
    .from('profiles')
    .update(row)
    .eq('id', currentUserId(queryClient))
    .select()
    .single();

  if (error) throw toQueryError(error);
  return camel<User>(data)!;
}

/** The signed-in Clerk user id, taken from the cached `my_profile()` payload. */
function currentUserId(queryClient: ReturnType<typeof useQueryClient>): string {
  const cached = queryClient.getQueryData<{ id: string }>(['me']);
  if (!cached?.id) {
    throw new Error('Cannot update your profile before the session has loaded.');
  }
  return cached.id;
}

export async function updateUser(
  id: string,
  patch: Partial<Pick<User, 'fullName' | 'role' | 'status' | 'employeeCode' | 'phone'>>,
): Promise<User> {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    row[key === 'role' ? 'role_id' : key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] =
      key === 'role' ? `role_${value}` : value;
  }

  const { data, error } = await getSupabase().from('profiles').update(row).eq('id', id).select().single();
  if (error) throw toQueryError(error);
  return camel<User>(data)!;
}

/**
 * Deactivate rather than delete.
 *
 * `profiles` is referenced by marks, submissions, OCR documents and audit rows;
 * deleting would either cascade away real marks or fail on the FK. Audit rows
 * carry a plain text id precisely so history outlives the account.
 */
export async function deactivateUser(id: string): Promise<void> {
  const { error } = await getSupabase().from('profiles').update({ status: 'inactive' }).eq('id', id);
  if (error) throw toQueryError(error);
}

/* -------------------------------------------------------------------------- */
/* Audit log                                                                    */
/* -------------------------------------------------------------------------- */

export async function listAuditLogs(params: ListParams): Promise<ListResponse<AuditLogEntry>> {
  const { page, pageSize, action, entityType, search } = params;

  let q = getSupabase().from('v_audit_logs').select('*', { count: 'exact' });

  if (action) q = q.eq('action', action);
  if (entityType) q = q.eq('entity_type', entityType);
  q = applySearch(q, orSearch(['action', 'entity_type', 'entity_id', 'user_email', 'reason'], search as string | undefined));

  return paginate<AuditLogEntry, typeof q>(q.order('created_at', { ascending: false }), {
    page: page as number,
    pageSize: pageSize as number,
  });
}

/** Distinct actions, for the filter dropdown. */
export async function listAuditActions(): Promise<string[]> {
  const { data, error } = await getSupabase().from('v_audit_logs').select('action').limit(1000);
  if (error) throw toQueryError(error);
  return [...new Set((data ?? []).map((r) => r.action as string))].sort();
}

/* -------------------------------------------------------------------------- */
/* Notifications                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One in-app notification.
 *
 * Declared here rather than reusing a shared type because the old
 * `Notification` interface carried fields this screen does not render
 * (`channel`, `data`), and a narrower shape means the panel cannot accidentally
 * depend on them.
 */
export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string;
  readAt: string | null;
  /** Convenience flag so the panel does not null-check `readAt` everywhere. */
  read: boolean;
}

/** Notifications for the signed-in user only — enforced by RLS, not by a filter. */
export async function listNotifications(limit = 15): Promise<NotificationItem[]> {
  const { data, error } = await getSupabase()
    .from('notifications')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw toQueryError(error);

  return camelMany<Record<string, unknown>>(data).map((row) => ({
    id: String(row.id),
    type: String(row.type),
    title: String(row.title),
    body: (row.body as string | null) ?? null,
    link: (row.link as string | null) ?? null,
    createdAt: String(row.createdAt),
    readAt: (row.readAt as string | null) ?? null,
    read: Boolean(row.readAt),
  }));
}

export async function countUnreadNotifications(): Promise<number> {
  const { count, error } = await getSupabase()
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .is('read_at', null);

  if (error) throw toQueryError(error);
  return count ?? 0;
}

export async function markNotificationsRead(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;

  // No user filter: RLS restricts the update to the caller's own rows, so there
  // is no way to mark somebody else's notification as read even if the id leaks.
  const { data, error } = await getSupabase()
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .in('id', ids)
    .select('id');

  if (error) throw toQueryError(error);
  return data?.length ?? 0;
}

export async function markAllNotificationsRead(): Promise<number> {
  const { data, error } = await getSupabase()
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .is('read_at', null)
    .select('id');

  if (error) throw toQueryError(error);
  return data?.length ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                     */
/* -------------------------------------------------------------------------- */

export type SettingsMap = Record<string, string>;

export async function getSettings(): Promise<SettingsMap> {
  const { data, error } = await getSupabase().from('settings').select('key, value');
  if (error) throw toQueryError(error);

  const out: SettingsMap = {};
  for (const row of data ?? []) out[row.key as string] = row.value as string;
  return out;
}

/**
 * Upsert a batch of settings.
 *
 * One call for all keys so the settings screen saves atomically-ish and the user
 * does not see a half-saved form after a network blip.
 */
export async function saveSettings(values: SettingsMap): Promise<void> {
  const rows = Object.entries(values).map(([key, value]) => ({
    key,
    value,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await getSupabase().from('settings').upsert(rows, { onConflict: 'key' });
  if (error) throw toQueryError(error);
}

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                    */
/* -------------------------------------------------------------------------- */

export interface AdminCounts {
  students: number;
  subjects: number;
  activeUsers: number;
  submissions: number;
  awaitingReview: number;
  inReview: number;
  approved: number;
  locked: number;
  ocrFailed: number;
  ocrPending: number;
}

export async function getAdminCounts(): Promise<AdminCounts> {
  const { data, error } = await getSupabase().from('v_admin_counts').select('*').maybeSingle();
  if (error) throw toQueryError(error);

  const row = (data ?? {}) as Record<string, number | string | null>;
  const n = (key: string) => Number(row[key] ?? 0);

  return {
    students: n('students'),
    subjects: n('subjects'),
    activeUsers: n('activeUsers'),
    submissions: n('submissions'),
    awaitingReview: n('awaitingReview'),
    inReview: n('inReview'),
    approved: n('approved'),
    locked: n('locked'),
    ocrFailed: n('ocrFailed'),
    ocrPending: n('ocrPending'),
  };
}

export interface TeacherSummary {
  sectionId: string;
  subjectId: string;
  academicYearId: string;
  drafts: number;
  returned: number;
}

/** The signed-in teacher's own assignment summary. */
export async function getTeacherSummary(teacherId: string): Promise<TeacherSummary[]> {
  const { data, error } = await getSupabase()
    .from('v_teacher_assignments_summary')
    .select('*')
    .eq('teacher_id', teacherId);

  if (error) throw toQueryError(error);
  return camelMany<TeacherSummary>(data);
}

/** Recent submissions for the teacher dashboard. */
export async function getRecentSubmissionsForTeacher(
  teacherId: string,
  limit = 8,
): Promise<MarkSubmission[]> {
  const { data, error } = await getSupabase()
    .from('v_submissions')
    .select('*')
    .eq('teacher_id', teacherId)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) throw toQueryError(error);
  return camelMany<MarkSubmission>(data);
}