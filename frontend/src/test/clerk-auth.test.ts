import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the Clerk sign-in integration against regressing to a broken pattern.
 *
 * `<SignIn routing="path" />` and `<SignUp routing="path" />` rendered a completely
 * empty `<div data-clerk-component="SignIn">` in this app — no form, no inputs, no
 * error, no console message — while `Clerk.openSignIn()` on the very same page
 * rendered the modal correctly. The routed components resolve their path against
 * the router `basename` (`/school-marks/`, required for GitHub Pages) and silently
 * produce nothing when that lookup fails.
 *
 * This is a static check rather than a render test because reproducing the failure
 * needs a live Clerk instance and a real session; the code pattern itself is the
 * thing worth pinning, and it is what actually broke.
 */

const here = dirname(fileURLToPath(import.meta.url));
// This file lives in `src/test/`, so the sources are one level up — not `src/src`.
const SRC = resolve(here, '..');

/**
 * Reads a source file verbatim.
 *
 * An earlier version stripped comments first, to avoid the prose in these files
 * tripping the assertions. That was worse than the problem: a naive block-comment
 * regex sees the glob-looking sequence inside the sign-in route string and deletes
 * real code up to wherever the next comment terminator happens to be. The assertions
 * below are instead written to require JSX context.
 * which only ever appears in code.
 */
function read(relative: string): string {
  return readFileSync(resolve(SRC, relative), 'utf8');
}

describe('Clerk sign-in integration', () => {
  it('does not mount the routed Clerk components, which render empty here', () => {
    const app = read('App.tsx');

    // Anchored to the JSX element= prop, so a prose mention in a comment can
    // neither satisfy nor trip this.
    expect(app).not.toMatch(/element=\{<SignIn[\s>]/);
    expect(app).not.toMatch(/element=\{<SignUp[\s>]/);
    expect(app).not.toMatch(/element=\{<SignIn\s+routing/);
  });

  it('still serves the sign-in and sign-up URLs, so old links keep working', () => {
    const app = read('App.tsx');

    expect(app).toMatch(/<Route\s+path="\/sign-in\/\*"/);
    expect(app).toMatch(/<Route\s+path="\/sign-up\/\*"/);
    // Redirect shims for the old bespoke login screen.
    expect(app).toMatch(/<Route\s+path="\/login"/);
    expect(app).toMatch(/<Route\s+path="\/forgot-password"/);
  });

  it('uses the v6 redirect prop names, not the pair removed in v6', () => {
    const modals = read('components/auth/ClerkModals.tsx');

    expect(modals).toMatch(/redirectProp="signInForceRedirectUrl"/);
    expect(modals).toMatch(/redirectProp="signUpForceRedirectUrl"/);
    // The v5 names were removed and are a compile error if used. Matched after a
    // quote character so the explanatory comments above do not trip this. Built from
    // unicode escapes, since a backtick cannot appear inside a regex literal.
    const QUOTE = '[\\u0027"\\u0022\\u0060]';
    expect(modals).not.toMatch(new RegExp(`${QUOTE}afterSignIn`));
    expect(modals).not.toMatch(new RegExp(`${QUOTE}afterSignUp`));
  });

  it('waits for Clerk to load before opening, or the call is a silent no-op', () => {
    const modals = read('components/auth/ClerkModals.tsx');

    // The bug behind the first attempt at the fix: opening on mount, before
    // clerk-js has initialised, does nothing and leaves the same blank page.
    expect(modals).toContain('isLoaded');
    expect(modals).toMatch(/if \(!isLoaded\) return;/);
  });

  it('sets a router basename, without which every route 404s under GitHub Pages', () => {
    const main = read('main.tsx');

    // The app is served from https://<user>.github.io/<repo>/, so without this the
    // router matches `/school-marks/` against `/` and renders the 404 page on the
    // landing URL.
    expect(main).toMatch(/<BrowserRouter\s+basename=/);
    expect(main).toContain('import.meta.env.BASE_URL');
  });

  it('signs out through the app root, because Pages serves / as a 404', () => {
    const auth = read('lib/auth.tsx');

    // Clerk performs the redirect itself and never sees the router basename, so
    // a bare '/' lands on https://<user>.github.io/ — outside the app.
    expect(auth).toMatch(/signOut\(\{\s*redirectUrl:\s*buildUrl\('\/'\)\s*\}\)/);
    expect(auth).not.toMatch(/redirectUrl:\s*['"`]\//);
  });
});
