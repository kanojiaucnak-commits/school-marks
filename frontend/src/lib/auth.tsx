import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth as useClerkAuth, useUser as useClerkUser } from '@clerk/react';
import type { CurrentUser, Permission, Role } from '@school/shared';
import { setSupabaseTokenGetter } from './supabase';
import { setEdgeTokenGetter } from './edge';
import { buildUrl } from './origin';
import { rpc } from './query';

/**
 * Authentication state.
 *
 * Identity now comes from Clerk; the school-specific profile (role, employee
 * code, status, permissions) comes from Postgres. Neither alone is enough:
 * Clerk knows who you are, the database knows what you may do, and Postgres RLS
 * is what actually enforces it.
 *
 * There is no session token in JavaScript any more. The old implementation
 * deliberately kept its token in an HttpOnly cookie; Clerk now holds it and
 * supabase-js forwards it on each request, so there is nothing to steal from
 * localStorage and no CSRF token to manage — a Bearer header is not sent
 * ambiently by the browser.
 */

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'unprovisioned';

interface AuthContextValue {
  user: CurrentUser | null;
  status: AuthStatus;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Shape returned by the `my_profile()` Postgres function. */
interface ProfilePayload extends Omit<CurrentUser, 'permissions'> {
  roleId: string;
  permissions: Permission[];
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken, signOut } = useClerkAuth();
  const { user: clerkUser } = useClerkUser();
  const queryClient = useQueryClient();

  const { data: profile, isFetching, isError } = useQuery({
    queryKey: ['me'],
    enabled: isLoaded && isSignedIn,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<ProfilePayload | null> => {
      // Provisioning is not this component's job. Clerk lets anyone sign up, so a
      // brand-new account has no `profiles` row; the `data-proxy` Edge Function's
      // `requireCaller()` creates it before any query runs, resolving the identity
      // from Clerk (a session token carries no `email` claim on a default instance).
      //
      // This used to call `provision_current_profile()` itself as a fallback. That was
      // a second, browser-reachable provisioning path which read the email from the
      // token — so it failed for exactly the accounts the Edge Function path would
      // have handled — and it duplicated logic in the one place that must not drift.
      const payload = await rpc<ProfilePayload | null>('my_profile');

      // A null result here is not "not provisioned" any more: `requireCaller()` has
      // already created the row. It means the row exists but is deactivated, which
      // the `unprovisioned` state below routes to the unavailable screen.
      if (payload) await rpc('touch_last_login').catch(() => undefined);
      return payload;
    },
  });

  const logout = useCallback(async () => {
    // Drop cached server state first: once the Clerk session is gone none of it
    // is readable, and leaving it cached would flash another user's rows.
    queryClient.clear();
    // Through `buildUrl`, never a bare `/`: Clerk resolves it against the origin
    // root, which on GitHub Pages is a 404 — the app lives at `/school-marks/`.
    await signOut({ redirectUrl: buildUrl('/') });
  }, [queryClient, signOut]);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['me'] });
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(() => {
    if (!isLoaded) return { user: null, status: 'loading', logout, refresh };

    if (!isSignedIn) return { user: null, status: 'anonymous', logout, refresh };

    // Signed in with Clerk, but no active `profiles` row. This happens when an
    // account exists in Clerk but has not been provisioned into the school, or
    // has been deactivated. It is a distinct state from "not signed in": the
    // person proved who they are, so telling them to sign in again would loop.
    // `isError` is grouped with `profile === null` deliberately. The old code
    // dispatched a global "signed out" event on any 401, which is wrong here: a
    // Supabase query returning 401 almost always means the caller lacks a
    // permission rather than that the session ended, and reacting to it would sign
    // a teacher out for opening a page they are not allowed to see. Clerk owns
    // session expiry and will sign them out itself.
    if (isError || profile === null) {
      return { user: null, status: 'unprovisioned', logout, refresh };
    }

    if (!profile) {
      return {
        user: null,
        status: isFetching ? 'loading' : 'unprovisioned',
        logout,
        refresh,
      };
    }

    const user: CurrentUser = {
      id: profile.id,
      email: profile.email,
      fullName: profile.fullName ?? clerkUser?.fullName ?? '',
      username: profile.username ?? clerkUser?.username ?? null,
      role: profile.role as Role,
      employeeCode: profile.employeeCode ?? null,
      phone: profile.phone ?? null,
      status: profile.status,
      permissions: profile.permissions,
      // Clerk owns password policy; the old admin-issued temporary password
      // flow no longer exists.
      mustChangePassword: false,
      lastLoginAt: profile.lastLoginAt ?? null,
    };

    return { user, status: 'authenticated', logout, refresh };
  }, [isLoaded, isSignedIn, isFetching, isError, profile, clerkUser, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

/** Current user, guaranteed non-null. Only call this behind a protected route. */
export function useCurrentUser(): CurrentUser {
  const { user } = useAuth();
  if (!user) throw new Error('useCurrentUser called outside an authenticated route');
  return user;
}

/**
 * Expose Clerk's token getter to the Supabase client and the Edge Function client.
 *
 * Registered during render rather than in an effect on purpose: a `useEffect`
 * runs *after* the first child queries fire, and those early requests would go
 * out with no token and come back as anonymous. The assignment is idempotent and
 * writes only to module scope, so doing it during render is safe.
 *
 * Both clients need it: supabase-js for PostgREST, and `edge.ts` for the functions
 * that bypass RLS via the service role and must therefore verify the token
 * themselves.
 */
export function SupabaseTokenBridge() {
  const { getToken } = useClerkAuth();
  setSupabaseTokenGetter(getToken);
  setEdgeTokenGetter(getToken);
  return null;
}