import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { UserProfile, useUser } from '@clerk/react';
import { updateProfileSchema, type UpdateProfileInput } from '@school/shared';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useAuth } from '../../lib/auth';
import { updateOwnProfile } from '../../lib/repos/admin';
import { roleLabel } from '../../lib/permissions';
import { Button } from '../../components/ui/Button';
import { Panel, TitledPanel } from '../../components/ui/Layout';
import { Alert } from '../../components/ui/States';
import { TextInput } from '../../components/ui/Field';
import { useToast } from '../../components/ui/Toast';
import { IconLogout, IconUser } from '../../components/ui/icons';

/**
 * Account settings.
 *
 * ── What changed and why ─────────────────────────────────────────────────────
 * This screen used to POST `/auth/change-password` and own a bespoke password
 * form with a strength meter. Clerk owns credentials now, so password management
 * is delegated to Clerk's `<UserProfile />` rather than reimplemented: our rules
 * and Clerk's could drift, and a password accepted by one form and rejected by
 * the other is a support call.
 *
 * What stays here is what Clerk has no opinion about — display name, phone,
 * employee code — which live in `profiles`.
 *
 * Deliberately NOT editable: role and status. A user must not be able to promote
 * themselves. The `profiles_update_self` RLS policy only matches on
 * `id = current_clerk_id()`, and a trigger rejects any attempt to change one's own
 * `role_id` without `user:update`.
 */
export default function ProfilePage() {
  const { user, refresh, logout } = useAuth();
  const { user: clerkUser } = useUser();
  const queryClient = useQueryClient();
  const { success } = useToast();
  const navigate = useNavigate();

  const [profileError, setProfileError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const form = useForm<UpdateProfileInput>({
    resolver: zodResolver(updateProfileSchema),
    defaultValues: {
      fullName: user?.fullName ?? '',
      phone: user?.phone ?? '',
    },
  });

  if (!user) return null;

  const saveProfile = form.handleSubmit(async (values) => {
    setProfileError(null);
    setSaving(true);

    try {
      await updateOwnProfile(queryClient, values);
      // `refresh()` re-reads `my_profile()`, so the header and every permission
      // check update from one source of truth rather than local state.
      await refresh();
      success('Profile updated');
    } catch (caught) {
      setProfileError(caught instanceof Error ? caught.message : 'Could not update your profile.');
    } finally {
      setSaving(false);
    }
  });

  const signOut = async () => {
    await logout();
    navigate('/', { replace: true });
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">
            Your school details, and the password you sign in with.
          </h1>
        </div>
        <Button icon={<IconLogout size={16} />} onClick={() => void signOut()}>
          Sign out
        </Button>
      </header>

      {/* Read-only identity: from Clerk and the database, not from a form. */}
      <TitledPanel title="Details">
        <dl className="grid gap-3 sm:grid-cols-2">
          <Detail label="Email" value={user.email} />
          <Detail label="Role" value={roleLabel(user.role)} />
          <Detail label="Employee code" value={user.employeeCode ?? '—'} />
          <Detail label="Permissions" value={`${user.permissions.length} granted`} />
        </dl>
        <p className="mt-4 text-xs text-ink-subtle">
          Your role and permissions are set by a school administrator.
        </p>
      </TitledPanel>

      {/* School-specific fields — the part Clerk has no opinion about. */}
      <TitledPanel
        title="Your details"
        description="How you appear to colleagues reviewing marks."
      >
        <form onSubmit={saveProfile} noValidate className="space-y-4">
          {profileError && <Alert tone="danger">{profileError}</Alert>}

          <TextInput
            label="Full name"
            autoComplete="name"
            leading={<IconUser size={16} />}
            error={form.formState.errors.fullName?.message}
            {...form.register('fullName')}
          />

          <TextInput
            label="Phone"
            type="tel"
            autoComplete="tel"
            hint="Used by reviewers if a mark sheet needs checking."
            error={form.formState.errors.phone?.message}
            {...form.register('phone')}
          />

          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={saving}>
              Save changes
            </Button>
          </div>
        </form>
      </TitledPanel>

      <TitledPanel
        title="Password and security"
        description="Change your password, review active sessions and set up two-factor authentication."
      >
        {/*
          Clerk's panel handles password, sessions and 2FA. It is deliberately not
          linked off-site: the password fields are why most people visit this
          screen, and a link to a hosted page reads as something is missing.
        */}
        <div className="rounded-lg border border-line-soft bg-surface-sunken p-4">
          {clerkUser ? (
            <ClerkUserProfile />
          ) : (
            <p className="text-sm text-ink-muted">Loading your security settings…</p>
          )}
        </div>
      </TitledPanel>

      <p className="text-xs text-ink-subtle">
        Changing your password signs out your other devices. If you are locked out, ask a school
        administrator to reset your account.
      </p>
    </div>
  );
}

/**
 * Clerk's `UserProfile`, imported statically.
 *
 * Deliberately not lazy-loaded: it is rendered on this screen unconditionally, so
 * a dynamic `import()` would add a loading state for a chunk that is always
 * needed, and the panel is the reason people come here.
 */
function ClerkUserProfile() {
  return (
    <UserProfile
      routing="hash"
      appearance={{
        elements: {
          rootBox: 'w-full',
          cardBox: 'shadow-none border-0',
        },
      }}
    />
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{value}</dd>
    </div>
  );
}
