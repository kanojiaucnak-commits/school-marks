import { useEffect, useRef, useState } from 'react';
import { useAuth as useClerkAuth, useClerk } from '@clerk/react';
import { useNavigate } from 'react-router-dom';
import { Crest } from '../ui/Crest';
import { SCHOOL } from '../../lib/school';

/**
 * Opens Clerk's sign-in / sign-up UI imperatively.
 *
 * ── Why not the routed Clerk components ───────────────────────────────────────
 *
 * They rendered an empty `<div data-clerk-component="SignIn">` — no form, no
 * inputs, no error, no console message. Confirmed by contrast on one page: the
 * routed component produced 0 inputs while `Clerk.openSignIn()` produced
 * `.cl-modalBackdrop` and 2 inputs. The routed components resolve their path
 * against the router `basename` (`/school-marks/`, needed for GitHub Pages) and
 * silently render nothing when that lookup fails. The imperative API does not
 * involve the router at all.
 *
 * The URLs are kept: `/sign-in` and `/sign-up` remain routes, so bookmarks and
 * existing links still work. They open the modal on arrival.
 *
 * ── Three separate ways this goes wrong, each found by running it ─────────────
 *
 * 1. `openSignIn()` is a **silent no-op until Clerk has loaded**. Calling it on
 *    mount — before `clerk-js` initialises — does nothing, reproducing the original
 *    blank page. Hence the `isLoaded` gate.
 *
 * 2. **Already signed in.** Clerk refuses to render the modal in single-session mode
 *    and reports `cannot_render_single_session_enabled`. Reading that as a failure
 *    showed "could not be opened" to a user who was, in fact, already authenticated.
 *    So an existing session now redirects onward instead.
 *
 * 3. `clerk.openSignIn` is **not referentially stable**. Listing it as an effect
 *    dependency made the effect re-run every render, calling `openSignIn()` again
 *    each time; Clerk treats that as a close, so the net result was
 *    open/close/open/close and the modal never appeared at all. Hence the ref.
 *
 * Clerk v6 also removed the v5 "after sign-in" redirect props; the replacements are
 * `signInForceRedirectUrl` and `signUpForceRedirectUrl`, and they are not
 * interchangeable.
 */

function buildUrl(path: string): string {
  const origin = import.meta.env.VITE_APP_ORIGIN;
  return origin ? `${origin}${path}` : path;
}

/**
 * How long to wait for Clerk's modal before offering a retry.
 *
 * Deliberately long. A false "it failed" is worse than a slow page: it tells the
 * user something untrue and hides a working form behind a retry button.
 */
const MODAL_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;

type OpenModal = (props?: Record<string, string>) => void;

function Opener({
  open,
  redirectProp,
  path,
  label,
}: {
  open: OpenModal;
  redirectProp: string;
  path: string;
  label: string;
}) {
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useClerkAuth();
  const navigate = useNavigate();
  const [timedOut, setTimedOut] = useState(false);
  const [clerkError, setClerkError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const timerRef = useRef<number | null>(null);

  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!isLoaded) return;

    // Already authenticated: there is nothing to sign in to, so send the user where
    // they were heading instead of showing an error.
    if (isSignedIn) {
      navigate(path, { replace: true });
      return;
    }

    setTimedOut(false);
    setClerkError(null);
    try {
      openRef.current.call(clerk, { [redirectProp]: buildUrl(path) });
    } catch (caught) {
      console.error(`Clerk: could not open ${label}`, caught);
      // Clerk's own message names the real reason, which is far more useful than
      // anything invented here.
      setClerkError(caught instanceof Error ? caught.message : String(caught));
      setTimedOut(true);
    }
  }, [isLoaded, isSignedIn, attempt, clerk, redirectProp, path, label, navigate]);

  // `openSignIn()` returns void, so the only evidence it worked is Clerk's markup.
  useEffect(() => {
    if (!isLoaded || isSignedIn) return;

    const started = Date.now();
    timerRef.current = window.setInterval(() => {
      if (document.querySelector('.cl-rootBox, .cl-modalContent')) {
        if (timerRef.current !== null) window.clearInterval(timerRef.current);
        timerRef.current = null;
        return;
      }
      if (Date.now() - started > MODAL_TIMEOUT_MS) {
        if (timerRef.current !== null) window.clearInterval(timerRef.current);
        timerRef.current = null;
        setTimedOut(true);
      }
    }, POLL_INTERVAL_MS);

    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [isLoaded, isSignedIn, attempt]);

  if (!isLoaded) {
    return (
      <p className="p-8 text-center text-sm text-ink-subtle" role="status">
        Loading sign-in…
      </p>
    );
  }

  if (isSignedIn) {
    return (
      <p className="p-8 text-center text-sm text-ink-subtle" role="status">
        Already signed in — taking you to your dashboard…
      </p>
    );
  }

  if (timedOut) {
    const clerkScriptRan =
      typeof (window as unknown as { Clerk?: unknown }).Clerk !== 'undefined';

    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="w-full max-w-md rounded-lg border border-line bg-surface p-6 text-center shadow-card">
          {/* The crest and school name sit on the failure screen too: this is the
              one moment a user is definitely looking, and it should look like the
              school's system rather than a generic error card. */}
          <div className="mb-4 flex flex-col items-center gap-2">
            <Crest size={40} />
            <p className="font-display text-sm font-bold leading-tight text-ink">{SCHOOL.name}</p>
          </div>

          <h1 className="text-lg font-semibold text-ink">{label}</h1>
          {clerkError ? (
            <p className="mt-2 whitespace-pre-line text-sm text-ink-muted">{clerkError}</p>
          ) : (
            <p className="mt-2 text-sm text-ink-muted">
              {clerkScriptRan
                ? 'Sign-in loaded but the window did not appear. This can happen on a slow ' +
                  'connection, or when a privacy extension blocks third-party requests.'
                : 'The authentication script did not load at all. Check your connection, and any ' +
                  'ad-blocking or privacy extension.'}
            </p>
          )}
          <button
            type="button"
            className="mt-4 rounded bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  // Clerk renders into a portal, so there is deliberately nothing here while it
  // works — anything painted would sit behind the modal.
  return null;
}

export function SignInOpener() {
  const clerk = useClerk();
  return (
    <Opener
      open={clerk.openSignIn}
      redirectProp="signInForceRedirectUrl"
      path="/app"
      label="Sign in"
    />
  );
}

export function SignUpOpener() {
  const clerk = useClerk();
  return (
    <Opener
      open={clerk.openSignUp}
      redirectProp="signUpForceRedirectUrl"
      path="/app"
      label="Create an account"
    />
  );
}
