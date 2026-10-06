import { useAuth } from '../lib/auth';
import { Button } from '../components/ui/Button';
import { IconAlertCircle } from '../components/ui/icons';

/**
 * Shown when Clerk has a valid session but Postgres has no active profile.
 *
 * This is a state the old hand-rolled auth could not produce: previously a user
 * and their account were the same row, so "signed in but not authorised" was
 * expressed as a permission denial. Splitting identity (Clerk) from the school
 * record (`profiles`) makes the mismatch a real, reachable state — someone whose
 * Clerk account was created but never provisioned, or whose profile was set to
 * `inactive` after they left.
 *
 * Signing in again cannot fix it, so this screen deliberately does not offer a
 * retry loop. It tells the user what happened and who can fix it.
 */
export function AccountUnavailablePage() {
  const { logout, refresh } = useAuth();

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-muted px-4">
      <div className="w-full max-w-md">
        <div className="card-surface p-6 text-center sm:p-8">
          <span
            aria-hidden="true"
            className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-warning-50 text-warning-strong"
          >
            <IconAlertCircle className="h-6 w-6" />
          </span>

          <h1 className="mt-5 text-xl font-semibold text-ink">
            Your account isn&apos;t set up yet
          </h1>

          <p className="mt-2.5 text-sm leading-relaxed text-ink-muted">
            You signed in successfully, but this account has not been added to the school yet,
            or it has been deactivated. A school administrator needs to provision it before you
            can see any marks data.
          </p>

          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Button onClick={() => void refresh()}>Check again</Button>
            <Button variant="primary" onClick={() => void logout()}>
              Sign out
            </Button>
          </div>
        </div>

        <p className="mt-5 text-center text-xs text-ink-subtle">
          If you expected access, ask an administrator to check your account status.
        </p>
      </div>
    </div>
  );
}