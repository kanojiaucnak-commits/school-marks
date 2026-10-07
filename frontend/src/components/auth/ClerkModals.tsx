import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAuth as useClerkAuth, useClerk } from '@clerk/react';
import { useNavigate } from 'react-router-dom';
import { buildUrl } from '../../lib/origin';
import { SCHOOL } from '../../lib/school';
import { Crest } from '../ui/Crest';

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
      <div className="flex min-h-[60vh] w-full items-center justify-center px-4">
        {/* `w-full` on the wrapper matters: as a flex item of the shell's
            `<main>` it would otherwise size to its content and collapse this
            card to a stub instead of honoring the inner `max-w-md`. */}
        <div className="w-full max-w-md rounded-lg border border-line bg-surface p-6 text-center shadow-card">
          {/* The shell above carries the school's identity; this card only has
              to state which step failed and why. */}
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

/**
 * The page *behind* the sign-in modal.
 *
 * Clerk's modal floats over whatever this route renders, and until now the
 * route rendered nothing: a modal on a blank page. The shell gives that page
 * the school's identity so the moment of signing in looks like the same system
 * as everything around it — in the loading state, behind the modal's veil, and
 * on the failure card alike.
 *
 * The layout is dictated by where Clerk's card sits: a ~26rem card, high of
 * centre, in the horizontal middle of the screen. So the identity goes where a
 * card never reaches — **top-left**, the same masthead the landing page
 * carries, plus one quiet line at the bottom edge. The middle stays empty for
 * the modal (and centred for the loading and failure states, which render with
 * no modal at all).
 *
 * Deliberately passive: no links, no controls, nothing that could compete
 * with or click through the modal's overlay.
 */
function SignInShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-app">
      {/* Top-left: the corner no centred card reaches, and the same
          masthead the landing page carries. */}
      <header className="flex items-center gap-2.5 px-5 pt-5 sm:px-8 sm:pt-7">
        <Crest size={34} />
        <div className="min-w-0 text-left">
          <p className="truncate font-display text-sm font-bold leading-tight text-ink">
            {SCHOOL.name}
          </p>
          <p className="truncate text-2xs font-medium uppercase tracking-[0.08em] text-ink-faint">
            Marks Management
          </p>
        </div>
      </header>

      {/* The middle belongs to Clerk's modal; the loading and failure states
          centre here when no modal is open. */}
      <main className="flex flex-1 items-center justify-center px-4">{children}</main>

      <footer className="px-5 pb-6 text-center sm:pb-8">
        <p className="text-2xs text-ink-faint">{SCHOOL.location}</p>
      </footer>
    </div>
  );
}

export function SignInOpener() {
  const clerk = useClerk();
  return (
    <SignInShell>
      <Opener
        open={clerk.openSignIn}
        redirectProp="signInForceRedirectUrl"
        path="/app"
        label="Sign in"
      />
    </SignInShell>
  );
}

export function SignUpOpener() {
  const clerk = useClerk();
  return (
    <SignInShell>
      <Opener
        open={clerk.openSignUp}
        redirectProp="signUpForceRedirectUrl"
        path="/app"
        label="Create an account"
      />
    </SignInShell>
  );
}
