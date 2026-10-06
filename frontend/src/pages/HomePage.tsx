import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { LinkButton } from '../components/ui/Button';
import { Crest } from '../components/ui/Crest';
import { SCHOOL } from '../lib/school';
import {
  IconCheck,
  IconShield,
  IconTarget,
  IconUsers,
  IconChart,
  IconScan,
} from '../components/ui/icons';

/**
 * Public landing page.
 *
 * This is the application's front door and the only page that shows no
 * application chrome. It deliberately renders the same copy for signed-in and
 * signed-out visitors: a marketing page that leaked "you have 3 sheets waiting
 * for review" would be a small but real information disclosure, and keeping the
 * content static means it can be prerendered/cached without auth concerns.
 *
 * The sign-in call to action routes to Clerk's hosted flow rather than embedding
 * a form, which is why there is no password field, no forgot-password link and no
 * reset-token handling anywhere in this codebase any more.
 *
 * ── A note on the hero ──────────────────────────────────────────────────────
 *
 * The previous hero led with "Clerk sign-in · Supabase Postgres · GitHub
 * Pages". That is a stack, not a promise, and on the front page of a school
 * system it is the sort of detail that makes the software look unfinished. The
 * school now leads, and the technical claim moved down to a single factual
 * sentence about who can see what — which is the part a parent or a governing
 * body would actually want to know.
 */

const FEATURES = [
  {
    icon: IconUsers,
    title: 'Students and classes',
    body: 'Year → class → section structure, enrolment records, guardians, and promotion that preserves every previous year’s results.',
  },
  {
    icon: IconChart,
    title: 'Marks entry',
    body: 'A grid per subject and exam with live totals, percentage and grade bands computed for you as you type.',
  },
  {
    icon: IconScan,
    title: 'OCR mark sheets',
    body: 'Upload a scanned mark sheet and extract student numbers, names and marks automatically, then review every suggestion before it counts.',
  },
  {
    icon: IconTarget,
    title: 'Review and approval',
    body: 'A real workflow — submitted, under review, approved, locked — with separation of duties so nobody marks and approves their own sheet.',
  },
  {
    icon: IconShield,
    title: 'Audit trail',
    body: 'Every change is recorded with who did it, when, and what the value was before. The log is append-only at the database level.',
  },
  {
    icon: IconCheck,
    title: 'Reports and exports',
    body: 'Subject, class and student reports on school letterhead, ready to print or export to CSV, XLSX or JSON.',
  },
] as const;

const WORKFLOW = [
  { step: '01', title: 'Enter or extract', body: 'Type marks into the grid, or upload a scanned mark sheet and let OCR pre-fill it.' },
  { step: '02', title: 'Submit', body: 'The teacher submits a completed sheet. It is editable until they do.' },
  { step: '03', title: 'Review', body: 'A reviewer checks it and can approve, return with comments, or reject.' },
  { step: '04', title: 'Lock', body: 'Approved sheets are locked against editing. Corrections afterwards require an explicit permission and are audited.' },
] as const;

export function HomePage() {
  const { user, status } = useAuth();

  const nav = user ? (
    <LinkButton to="/app" variant="primary" size="lg">
      Open the app
    </LinkButton>
  ) : (
    <LinkButton to="/sign-in" variant="primary" size="lg">
      Sign in
    </LinkButton>
  );

  return (
    <div className="min-h-screen bg-app">
      {/* ---------------------------------------------------------------- */}
      {/* Masthead                                                        */}
      {/* ---------------------------------------------------------------- */}
      <header className="sticky top-0 z-20 border-b border-line-soft bg-surface/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2.5">
            <Crest size={34} />
            <div className="min-w-0">
              <p className="truncate font-display text-sm font-bold leading-tight text-ink">
                {SCHOOL.name}
              </p>
              <p className="truncate text-2xs font-medium uppercase tracking-[0.08em] text-ink-faint">
                Marks Management
              </p>
            </div>
          </div>

          <nav className="flex items-center gap-1.5">
            {user && (
              <Link
                to="/app"
                className="hidden rounded px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink sm:block"
              >
                Dashboard
              </Link>
            )}
            {nav}
          </nav>
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* Hero                                                            */}
      {/* ---------------------------------------------------------------- */}
      <section className="border-b border-line-soft bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
          <div className="max-w-3xl">
            <p className="eyebrow">Academic session 2026–27</p>

            <h1 className="mt-4 font-display text-4xl font-black leading-[1.1] tracking-[-0.02em] text-ink sm:text-5xl">
              Every mark, from scanned sheet to locked record.
            </h1>

            <div className="rule-brand mt-6" />

            <p className="mt-6 text-lg leading-relaxed text-ink-muted">
              A marks management system for {SCHOOL.name}. OCR reads the mark sheet, teachers
              correct it, reviewers approve it, and every change is recorded. Students never see
              another student’s marks, and teachers only ever see the classes they are assigned to.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              {nav}
              {!user && (
                <a
                  href="#how-it-works"
                  className="inline-flex h-control-md select-none items-center justify-center whitespace-nowrap rounded border border-line bg-surface px-4 text-sm font-medium text-ink transition-colors duration-100 hover:bg-surface-sunken"
                >
                  How it works
                </a>
              )}
            </div>

            <p className="mt-6 text-sm text-ink-faint">
              Teachers and reviewers sign up here, then request the classes they teach — an
              administrator approves each one.
            </p>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Features                                                        */}
      {/* ---------------------------------------------------------------- */}
      <section className="border-b border-line-soft py-16 sm:py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <h2 className="font-display text-2xl font-bold tracking-tight text-ink sm:text-3xl">
            Built around how schools actually work
          </h2>
          <div className="rule-brand mt-4" />
          <p className="mt-5 max-w-2xl text-ink-muted">
            Nothing here is theoretical — each feature below exists because the workflow needed
            it.
          </p>

          <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <li key={title} className="card-surface p-5">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <h3 className="mt-4 font-semibold text-ink">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Workflow                                                        */}
      {/* ---------------------------------------------------------------- */}
      <section id="how-it-works" className="border-b border-line-soft bg-surface py-16 sm:py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <h2 className="font-display text-2xl font-bold tracking-tight text-ink sm:text-3xl">
            From mark sheet to locked record
          </h2>
          <div className="rule-brand mt-4" />

          <ol className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {WORKFLOW.map(({ step, title, body }) => (
              <li key={step} className="border-t-2 border-sage-500 pt-4">
                <span className="tabular text-xs font-semibold text-brand-700">{step}</span>
                <h3 className="mt-2 font-semibold text-ink">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Closing call to action                                          */}
      {/* ---------------------------------------------------------------- */}
      <section className="py-16 sm:py-20">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
          <h2 className="font-display text-2xl font-bold tracking-tight text-ink sm:text-3xl">
            {status === 'loading' ? 'Checking your session…' : 'Ready when you are'}
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-ink-muted">
            {user
              ? `Signed in as ${user.fullName}. Head straight to your dashboard.`
              : 'Sign in with your school account to continue.'}
          </p>
          <div className="mt-8 flex justify-center">{nav}</div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Footer                                                          */}
      {/* ---------------------------------------------------------------- */}
      <footer className="border-t border-line bg-brand-800 text-white/70">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3">
              <Crest size={36} />
              <div>
                <p className="font-display text-sm font-bold text-white">{SCHOOL.name}</p>
                <p className="mt-0.5 text-xs text-white/60">{SCHOOL.location}</p>
                {SCHOOL.authority && (
                  <p className="mt-1 max-w-sm text-2xs text-white/50">{SCHOOL.authority}</p>
                )}
              </div>
            </div>

            <div className="text-xs sm:text-right">
              {SCHOOL.affiliation && <p className="text-white/70">{SCHOOL.affiliation}</p>}
              {SCHOOL.phone && <p className="tabular mt-1 text-white/50">{SCHOOL.phone}</p>}
              {SCHOOL.website && (
                <a
                  href={SCHOOL.website}
                  className="mt-1 inline-block text-white/50 transition-colors hover:text-white"
                  rel="noreferrer noopener"
                >
                  {SCHOOL.website.replace(/^https?:\/\//, '')}
                </a>
              )}
            </div>
          </div>

          <p className="mt-8 border-t border-white/10 pt-6 text-2xs leading-relaxed text-white/40">
            Marks are confidential records. Handle them in line with the school&apos;s
            data-protection policy.
          </p>
        </div>
      </footer>
    </div>
  );
}
