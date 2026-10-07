import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { ClerkProvider } from '@clerk/react';
import { App } from './App';
import { queryClient } from './lib/queryClient';
import { AuthProvider, SupabaseTokenBridge } from './lib/auth';
import { ToastProvider } from './components/ui/Toast';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root was not found in index.html');

const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * Fail loudly and usefully when the project has not been configured yet.
 *
 * ClerkProvider throws a bare "Missing publishableKey" otherwise, which reads
 * like a bug in the app rather than a missing .env.local — and this app cannot
 * render at all without a publishable key, so there is no useful partial state
 * to show.
 */
if (!clerkKey || !supabaseUrl || !supabaseKey) {
  const missing = [
    !clerkKey && 'VITE_CLERK_PUBLISHABLE_KEY',
    !supabaseUrl && 'VITE_SUPABASE_URL',
    !supabaseKey && 'VITE_SUPABASE_ANON_KEY',
  ].filter(Boolean);

  container.innerHTML = `
    <div style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.6;">
      <h1 style="font-size: 1.5rem; margin: 0 0 0.75rem;">Configuration needed</h1>
      <p style="color: #475569; margin: 0 0 1rem;">
        This app needs the following environment variables. Copy
        <code>frontend/.env.example</code> to <code>frontend/.env.local</code> and fill them in:
      </p>
      <ul style="color: #b91c1c; font-family: ui-monospace, monospace; margin: 0 0 1.5rem;">
        ${missing.map((k) => `<li>${k}</li>`).join('')}
      </ul>
      <p style="color: #475569; margin: 0;">
        Restart the dev server after editing the file.
      </p>
    </div>
  `;
} else {
  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          {/* BrowserRouter first: Clerk's redirect and popup flows benefit from a
              router that is already mounted.

              `basename` is mandatory, not cosmetic. The app is served from
              `https://<user>.github.io/<repo>/`, so without it the router matches
              `/school-marks/` against the `/` route, finds nothing, and renders the
              404 page on the landing URL — the app boots and then immediately
              claims its own root does not exist. `BASE_URL` comes from Vite's
              `base`, so the two cannot drift.

              The trailing slash is stripped because React Router treats
              `/school-marks` as a prefix; leaving it in makes `/school-marks/` fail
              to match the `/` route. */}
          <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <ClerkProvider
              publishableKey={clerkKey}
              /*
                Clerk's modal is the one piece of UI this app does not draw
                itself, so `appearance.variables` is the only lever on how it
                presents. Colour and type only — no structural overrides — which
                is the difference between "Clerk's dialog wearing the school's
                accent" and a card that clearly belongs to another product.
                Values mirror the brand tokens in `tailwind.config.js`
                (brand-600, ink, surface); if those change, change these.
              */
              appearance={{
                variables: {
                  colorPrimary: '#43616f',
                  colorForeground: '#1a1813',
                  colorMutedForeground: '#6f6655',
                  colorBackground: '#ffffff',
                  // The veil over our sign-in shell: a warm dark tint rather
                  // than Clerk's neutral black, so the page behind the modal
                  // still reads as parchment-under-glass. Alpha form is
                  // deliberate: the hex form of this variable rendered fully
                  // opaque and hid the shell entirely.
                  colorModalBackdrop: 'rgba(46, 42, 33, 0.68)',
                  // The focus ring around the card, in the brand rather than
                  // Clerk's default blue — it sits on top of our veil, so an
                  // off-palette blue is the loudest thing on the page.
                  colorRing: '#43616f',
                  borderRadius: '6px',
                  fontFamily:
                    'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                },
              }}
            >
              {/* Hands Clerk's getToken to the Supabase client before any child
                  query can fire. */}
              <SupabaseTokenBridge />
              <AuthProvider>
                <App />
              </AuthProvider>
            </ClerkProvider>
          </BrowserRouter>
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}