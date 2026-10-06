import { audit, requireCaller, hasPermission } from '../_shared/auth.ts';
import { fail, handle, json, readJson } from '../_shared/http.ts';

/**
 * Create the Clerk account, then provision the school profile.
 *
 * This function exists because the browser cannot do either half of user
 * creation:
 *
 *  - Creating a Clerk user needs the **secret key**, which must never reach the
 *    browser bundle.
 *  - Writing `profiles` needs the service role, which bypasses RLS — so the
 *    permission check below is what stops any signed-in teacher provisioning
 *    themselves an admin.
 *
 * Order matters: the Clerk user is created first, because the `profiles` row is
 * keyed by the Clerk user id. If provisioning then fails, the Clerk account is
 * deleted again — an orphaned account with no profile would show the
 * "account isn't set up yet" screen forever, and an administrator would have no
 * way to tell it apart from an un-provisioned stranger.
 */

Deno.serve(
  async (request) =>
    handle(request, async () => {
      const caller = await requireCaller(request);

      if (!(await hasPermission(caller, 'user:create'))) {
        return fail('FORBIDDEN', 'You do not have permission to create accounts.', 403);
      }

      const body = await readJson<{
        email?: string;
        fullName?: string;
        role?: string;
        employeeCode?: string | null;
        phone?: string | null;
        sendInvite?: boolean;
      }>(request);

      const email = body.email?.trim().toLowerCase();
      const fullName = body.fullName?.trim();
      const role = body.role ?? 'teacher';

      if (!email || !email.includes('@')) {
        return fail('VALIDATION_ERROR', 'A valid email address is required.', 400);
      }

      if (!fullName) {
        return fail('VALIDATION_ERROR', 'A full name is required.', 400);
      }

      // Only the three known roles. An unrecognised value must never fall through
      // to something privileged.
      if (!['admin', 'teacher', 'reviewer'].includes(role)) {
        return fail('VALIDATION_ERROR', `"${role}" is not a valid role.`, 400);
      }

      // Belt and braces: an admin may not mint another admin without already
      // holding user:create, which only admins have — but make the intent explicit
      // rather than relying on that coincidence.
      if (role === 'admin' && caller.role !== 'admin') {
        return fail('FORBIDDEN', 'Only an administrator can create another administrator.', 403);
      }

      const secretKey = Deno.env.get('CLERK_SECRET_KEY');
      if (!secretKey) {
        console.error('CLERK_SECRET_KEY is not set');
        return fail('SERVICE_UNAVAILABLE', 'Account creation is not configured.', 503);
      }

      // Does a profile already exist for this email? Catching it here gives a
      // much clearer message than the unique violation would.
      const { data: existing } = await caller.supabase
        .from('profiles')
        .select('id')
        .eq('email', email)
        .maybeSingle();

      if (existing) {
        return fail('CONFLICT', 'An account already exists for that email address.', 409);
      }

      // 1. Create the Clerk user.
      let clerkUserId: string;

      try {
        const clerkResponse = await fetch('https://api.clerk.com/v1/users', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${secretKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            email_address: [email],
            first_name: fullName.split(/\s+/)[0] ?? fullName,
            last_name: fullName.split(/\s+/).slice(1).join(' ') || undefined,
            // The role is mirrored here so the `handle_new_user()` trigger in
            // 0002_rls.sql assigns the right role even if this function is
            // interrupted before the profile insert.
            public_metadata: { role },
            // Skip the password prompt: the user sets their own via Clerk's
            // reset flow, which is better than an admin-chosen temporary one.
            skip_password_requirement: true,
          }),
        });

        if (!clerkResponse.ok) {
          const detail = await clerkResponse.text();
          console.error('clerk createUser failed', clerkResponse.status, detail);
          return fail(
            'INTERNAL_ERROR',
            'The account could not be created in the identity provider.',
            502,
          );
        }

        const clerkUser = (await clerkResponse.json()) as { id: string };
        clerkUserId = clerkUser.id;

        if (body.sendInvite) {
          await fetch(`https://api.clerk.com/v1/users/${clerkUserId}/invitations`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${secretKey}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          }).catch((caught) => console.warn('invite failed', caught));
        }
      } catch (caught) {
        console.error('clerk createUser threw', caught);
        return fail('SERVICE_UNAVAILABLE', 'Could not reach the identity provider.', 503);
      }

      // 2. Provision the school profile.
      const { data: profile, error: profileError } = await caller.supabase
        .from('profiles')
        .insert({
          id: clerkUserId,
          email,
          full_name: fullName,
          role_id: `role_${role}`,
          employee_code: body.employeeCode ?? null,
          phone: body.phone ?? null,
        })
        .select()
        .single();

      if (profileError) {
        // Roll back the Clerk account rather than leaving an unusable orphan.
        await fetch(`https://api.clerk.com/v1/users/${clerkUserId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${secretKey}` },
        }).catch((caught) => console.error('rollback failed', caught));

        console.error('profiles insert failed', profileError);
        return fail('INTERNAL_ERROR', 'The profile could not be created. The account was rolled back.', 500);
      }

      await audit(caller, {
        action: 'user.create',
        entityType: 'profile',
        entityId: clerkUserId,
        newValue: { email, role },
      });

      // The clerkUserId is returned so the admin can tell the user where to sign
      // in. It is not a secret — it is the identifier in the Clerk dashboard.
      return json({ profile, clerkUserId }, 201);
    }),
);