import { getSupabase } from './supabase';
import { QueryError } from './query';

/**
 * Supabase Edge Functions client.
 *
 * Some of this system's work genuinely cannot run in a browser: OCR against
 * Google Vision / Azure / Textract, XLSX generation, student CSV import, and
 * minting signed URLs (which requires the service role the browser must never
 * hold). Those live in `supabase/functions/`.
 *
 * The Clerk token is attached the same way it is for PostgREST. Edge Functions
 * verify it against the Clerk JWKS and call `has_permission()` themselves,
 * because RLS is bypassed by the service-role client they use internally.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** Clerk's `getToken`, registered by <SupabaseTokenBridge />. */
let tokenGetter: (() => Promise<string | null>) | null = null;

export function setEdgeTokenGetter(fn: () => Promise<string | null>): void {
  tokenGetter = fn;
}

export function isEdgeConfigured(): boolean {
  return Boolean(SUPABASE_URL && ANON_KEY);
}

/**
 * The current Clerk token, or the anon key when nobody is signed in.
 *
 * Exposed for the one caller that cannot use `edgeFetch` — the import template,
 * which returns a file body rather than JSON and so bypasses the envelope.
 */
export async function getEdgeToken(): Promise<string> {
  if (tokenGetter) {
    try {
      const token = await tokenGetter();
      if (token) return token;
    } catch {
      // Fall through to the anon key; the function will answer 401.
    }
  }

  return ANON_KEY ?? '';
}

export interface EdgeOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** `FormData` for uploads — the browser must set the multipart boundary. */
  body?: unknown;
  /** Seconds the function may take before the platform aborts it. */
  timeoutSeconds?: number;
}

/**
 * Invoke an Edge Function and return its JSON body.
 *
 * No caching: every one of these is either a mutation or a read the caller
 * expects to reflect the current state.
 */
export async function edgeFetch<T>(name: string, options: EdgeOptions = {}): Promise<T> {
  if (!SUPABASE_URL || !ANON_KEY) {
    throw new QueryError(
      'NOT_CONFIGURED',
      'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
    );
  }

  let token: string | null = null;
  try {
    token = tokenGetter ? await tokenGetter() : null;
  } catch {
    // A failed refresh surfaces as a 401 below, which the auth provider handles.
  }

  const headers: Record<string, string> = {
    apikey: ANON_KEY,
    accept: 'application/json',
    Authorization: token ? `Bearer ${token}` : `Bearer ${ANON_KEY}`,
  };

  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    body = options.body; // no content-type: the boundary is added automatically
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: options.method ?? 'POST',
      headers,
      body,
    });
  } catch {
    throw new QueryError('SERVICE_UNAVAILABLE', 'Could not reach the server. Check your connection and try again.');
  }

  const text = await response.text();

  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      // Not JSON — usually a platform-level error page.
      payload = null;
    }
  }

  /**
   * Every function answers in the envelope `supabase/functions/_shared/http.ts`
   * defines: `{ success, data }` or `{ success, error: { code, message } }`.
   *
   * `error` is an **object**, not a string. Reading it as a flat `body.error`
   * string made the whole object the QueryError's *code* and left the message as
   * the stringified object, so every failed call surfaced to the user as the
   * literal text `[object Object]` — see the toast in ReportsPage. Unwrap it.
   */
  const envelope = payload as
    | { success?: boolean; data?: unknown; error?: { code?: string; message?: string; details?: unknown; hint?: string } }
    | null;

  if (!response.ok || envelope?.success === false) {
    const failure = envelope?.error;
    throw new QueryError(
      failure?.code ?? 'EDGE_ERROR',
      failure?.message ?? `The request failed with status ${response.status}.`,
      failure?.details,
      failure?.hint ?? null,
    );
  }

  /**
   * Unwrap `data` so callers get what the function actually returned.
   *
   * `openPrintableReport` destructures `{ html }` and `downloadViaEdge`
   * `{ url }` from this result. Returning the envelope itself meant both were
   * `undefined`: the popup was written the text `undefined`, and every download
   * reported "The download could not be started."
   *
   * A function that legitimately returns nothing resolves to `null` rather than
   * being mistaken for an error — the success flag, not the payload, decides that.
   */
  return (envelope?.data ?? null) as T;
}

/**
 * Invoke a function that returns a URL, and fetch it in one step.
 *
 * Saves every caller from repeating "call, then download the blob, then click a
 * temporary anchor" — the pattern every export and template path needs.
 */
export async function downloadViaEdge<T>(
  name: string,
  body: unknown,
  filename: string,
): Promise<void> {
  const { url } = await edgeFetch<{ url: string }>(name, { method: 'POST', body });

  const response = await fetch(url);
  if (!response.ok) {
    throw new QueryError('DOWNLOAD_FAILED', 'The download could not be started.');
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

/**
 * Open a print-ready HTML report in a new window.
 *
 * The retired Worker served these as `text/html` with `window.print()` injected.
 * "PDF export" in this app has always meant HTML plus the browser's print
 * dialog — that behaviour is preserved rather than quietly replaced with a real
 * PDF library nobody asked for.
 */
export async function openPrintableReport(name: string, body: unknown): Promise<void> {
  const { html } = await edgeFetch<{ html: string }>(name, { method: 'POST', body });

  const popup = window.open('', '_blank');
  if (!popup) {
    throw new QueryError(
      'POPUP_BLOCKED',
      "Your browser blocked the report window. Allow pop-ups for this site.",
    );
  }

  popup.document.open();
  popup.document.write(html);
  popup.document.close();
}

/**
 * Direct Storage access.
 *
 * Removed: Supabase Storage verifies bearer tokens with the same key as PostgREST,
 * so a Clerk token cannot reach it, and `data-proxy` covers SQL rather than object
 * storage. Downloads go through the `export-download` function, which checks the
 * caller's permission and returns a short-lived signed URL.
 */