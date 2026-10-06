# Sign-up walkthrough

A step-by-step guide to getting people into the marks system — how a teacher
signs themselves up, how an administrator adds someone, and how class access is
granted. Each step names the exact button and screen so it can be followed
without the code.

There are **two ways in**, and they meet in the middle:

| Path | Who | How it works |
| --- | --- | --- |
| Self sign-up | Any teacher | Signs up from the public landing page. The server creates their profile automatically as a **Teacher** with no classes. They then *request* the classes they teach, and an administrator approves. |
| Admin invite | Administrator | Adds the person by name and email and picks their role. Clerk emails an invitation; the teacher sets their own password. |

---

## Roles at a glance

| Role | What they can do |
| --- | --- |
| **Administrator** | Everything. Sees all students, marks, reports and exports; manages teachers, classes, sections, subjects, exams, grading schemes, assignments, class requests and settings. The one thing an admin *cannot* do is request a class — they assign people directly instead. |
| **Reviewer / Principal** | Sees all mark sheets across the school; reviews, approves, returns and locks them; manages grading schemes; lists users. |
| **Teacher** | Only the classes assigned to them. Enters and submits marks, reads their own students, uploads and confirms OCR mark sheets, requests additional classes. |

There is no separate "super admin" role. **Administrator is the top of the
role matrix.** Nothing is seeded that way automatically, though — see below.

---

## Before the first teacher signs up: create the first administrator

Self-service sign-up always grants the role **teacher**, deliberately. An
automatic "first user becomes admin" rule would hand full control to whoever
happened to sign up first on a publicly reachable form, so the first
administrator is promoted once, by hand.

After the first account exists, run this in the Supabase dashboard
**SQL editor** (or any service-role connection):

```sql
update public.profiles
   set role_id = 'role_admin'
 where email = 'you@example.com';
```

The new permissions apply on the account's next sign-in. Role changes made
from the Teachers screen sign the user out automatically so the change takes
effect immediately.

---

## Path A — Teacher self sign-up

A brand-new teacher can do this end to end with nothing but their school email.

1. **Open the app's home page.** The landing page shows the school's name and
   a **Sign in** button.

2. **Click Sign in.** Clerk's hosted window opens. Choose **Create account**
   inside it, or go straight to the `/sign-up` URL — both open the same flow.
   Sign up with your school email (and a password you set yourself), or with
   Google if the school has enabled it. Verify the email if Clerk asks.

3. **After sign-up you land on the dashboard** (`/app`). On your first
   authenticated request the server creates your school profile automatically:
   role **Teacher**, status **Active**. There is no wizard and nothing to wait
   for — the profile is created for you.

4. **What a fresh teacher can see.** The dashboard shows *"Nothing is waiting
   for you"* (no mark sheets yet), and the sidebar lists **Dashboard** and
   **My classes**. Buttons like Enter marks or OCR appear, yet every student
   record and mark sheet stays hidden until you hold an approved assignment —
   that is enforced by the server on every request, not by hiding the buttons.

5. **Request the classes you teach.** Sidebar → **My classes**. Choose
   **Academic year**, then **Class and section**, then **Subject**, and click
   **Request this class**. Use your real teaching combination — an
   administrator sees your name and email on the request.

   The request appears in the list below as *"⏳ Waiting for approval"*. You
   can **Withdraw** it while it is still pending.

6. **Wait for an administrator to approve.** There is no email or bell
   notification for the verdict — check back on **My classes**, or ask the
   administrator. When approved the status changes to *"✓ Approved"* and the
   class's students and mark sheets become visible, so you can start entering
   marks. If it is declined you'll see *"✕ Declined"* (with the reason, when
   the administrator wrote one) and you can request again.

> Use your real school email. The account is matched on it and the
> administrator sees it on every request.

---

## Path B — Administrator adds a teacher

The administrator path is for people who should have access *before* they
ever sign in — and for anyone who needs a role other than plain Teacher.

1. **Sign in as an administrator.** Open **Teachers** from the sidebar
   (People → Teachers), or your avatar menu → **Manage users**.

2. **Add user.** Enter the full name, the school email, and the role
   (**Teacher**, **Reviewer / Principal**, or **Administrator**). Employee
   code and phone are optional. *"Send invitation email"* is on by default.

3. **The server does three things in one step:** creates the account in
   Clerk, creates the school profile with the role you chose, and asks Clerk
   to email an invitation. There is no password to hand over — the person
   sets their own on first sign-in.

4. **The teacher opens the invitation**, sets a password, and signs in. The
   profile already exists with the right role, so they land directly on the
   dashboard. If you chose Teacher, they still need an approved class request
   (or a direct assignment) before they see any data.

Also on **Teachers**: **Edit** changes role, status or employee code (a role
change signs the user out so it applies immediately); **Deactivate** revokes
sign-in while keeping all historical marks and submissions.

---

## Approving a teacher's request (administrator)

1. Sidebar → **Setup** → **Class requests**.

2. Pending requests show the teacher's name and email, the class · section,
   the subject and the year.

3. **Approve** grants access immediately — approving writes the teacher's
   real `teacher_assignments` row in the same database transaction, so a
   request can never be marked approved without the access existing.
   **Decline** can carry an optional reason that the teacher sees.

4. Two shortcuts if you'd rather not use the queue: **Teacher assignments**
   (Setup) grants a class directly, and **Teachers** manages the accounts
   themselves.

A sign-in without the permission to decide sees the queue but read-only —
the screen says so rather than offering refused buttons.

---

## Testing it yourself, end to end

Use two different browsers (or incognito windows) and two email addresses —
one for the teacher, one for the administrator.

1. **Browser A**: sign up the teacher and request a class on **My classes**.
2. **Browser B**: make an administrator — either promote an existing account
   with the SQL above, or have an existing administrator add a second person.
3. **Browser B**: open **Class requests** and **Approve** the teacher's
   request.
4. **Browser A**: reopen **My classes** — the status is *"✓ Approved"*.
   Open **Enter marks**: the class's students are now visible; before
   approval that list was empty.

---

## Troubleshooting

| You see | What it means | What to do |
| --- | --- | --- |
| *"Your account isn't set up yet"* (after signing in) | The Clerk session is valid but the school profile is missing or deactivated. | An administrator checks the person on **Teachers** (or promotes / reactivates the account). Signing in again can't fix it — this is not a session problem. |
| *"Your sign-in account has no email address"* | The Clerk account carries no usable email, so a school profile cannot be created. | Add an email address in the account's Clerk settings, then sign in again. |
| The sign-in window never appears | Clerk's script was blocked (slow connection, ad-blocker, privacy extension). | The app shows a retry screen explaining this; click **Try again**, or disable the blocker. |
| Old screens still showing after a role change | Permissions apply from the next session. | Sign out and back in — a change made by an administrator signs you out automatically. |
| Forgot the password | Clerk owns password policy and resets. | Use **Forgot password?** in the sign-in window. |
| **Request this class** is disabled | A year, section and subject must all be chosen, and you cannot request a combination you already have pending or approved. | Pick each dropdown; combinations you already hold are filtered out of the subject list. |

---

## Where the rules live (for developers)

| Behaviour | Where it is implemented |
| --- | --- |
| Self-service sign-up provisions a **teacher** (never an admin) profile | `supabase/migrations/0013_provision_from_function.sql`, `0015_fix_provision_profile_as.sql`; handed to the database by `requireCaller()` in `supabase/functions/_shared/auth.ts` |
| Request a class / approve a request | `request_assignment()` and `decide_assignment_request()` in `supabase/migrations/0008_self_service_onboarding.sql`; screens in `frontend/src/pages/MyClassesPage.tsx` and `frontend/src/pages/admin/ClassRequestsPage.tsx` |
| A teacher sees only approved classes | RLS in `supabase/migrations/0002_rls.sql` via `is_assigned_to()` / `can_read_sheet()` |
| Admin creates a Clerk account + profile + invite | `admin-create-clerk-user` Edge Function; `frontend/src/lib/repos/admin.ts` |