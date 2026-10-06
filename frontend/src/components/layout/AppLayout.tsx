import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS } from '@school/shared';
import { countUnreadNotifications } from '../../lib/repos/admin';
import { useAuth } from '../../lib/auth';
import { useAcademicYears } from '../../hooks/useAcademicYears';
import { can, navigationFor, roleLabel } from '../../lib/permissions';
import { cn, initialsOf } from '../../lib/utils';
import {
  ICONS,
  IconBell,
  IconCalendar,
  IconChevronDown,
  IconClose,
  IconLogout,
  IconMenu,
  IconUser,
  IconUsers,
  type IconProps,
} from '../ui/icons';
import { NotificationPanel } from './NotificationPanel';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { Wordmark } from '../ui/Wordmark';

/**
 * Application shell.
 *
 * Three-column layout: a compact sidebar for navigation, a sticky header that
 * provides context rather than controls, and the routed content.
 *
 * Decisions worth stating:
 *
 *  - **The sidebar is 15rem.** Wide enough for a real label, narrow enough that
 *    the data gets the screen. It collapses to a drawer on small viewports and
 *    closes on navigation, so tapping a link never leaves the drawer covering
 *    the page it opened.
 *  - **The active item is marked by a left rail and bolder text**, not a filled
 *    pill. A filled background competes with the data on the page.
 *  - **The header carries breadcrumb and notifications only.** Page-specific
 *    actions belong to the page, rendered in its own `PageHeader` — otherwise
 *    every screen inherits a toolbar it cannot use.
 *  - **The current academic year sits in the sidebar footer.** It is context for
 *    the entire session rather than a filter, and putting it next to the user's
 *    identity groups the two things that orient a user.
 */

export function AppLayout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notificationsRef = useRef<HTMLDivElement>(null);

  const sections = useMemo(() => navigationFor(user), [user]);

  // Close the drawer and any popovers whenever the route changes.
  useEffect(() => {
    setSidebarOpen(false);
    setNotificationsOpen(false);
  }, [location.pathname]);

  const { data: unread } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: countUnreadNotifications,
    refetchInterval: 60_000,
    staleTime: 30_000,
    enabled: Boolean(user),
  });

  // A click outside the notification panel closes it, which is what a user
  // expects from a popover that is not a modal.
  useEffect(() => {
    if (!notificationsOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!notificationsRef.current?.contains(event.target as Node)) setNotificationsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNotificationsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [notificationsOpen]);

  const handleLogout = async () => {
    await logout();
    queryClient.clear();
    navigate('/', { replace: true });
  };

  return (
    <div className="flex min-h-screen bg-app">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-canvas-inverse/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      <Sidebar
        open={sidebarOpen}
        sections={sections}
        user={user}
        onClose={() => setSidebarOpen(false)}
        onLogout={handleLogout}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/*
          The header is context, not controls: it holds the breadcrumb trail and
          the notification bell, nothing else. It carries `no-print` because the
          app chrome must not appear on a printed mark sheet.
        */}
        <header className="no-print sticky top-0 z-20 flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="-ml-1 rounded p-1.5 text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink lg:hidden"
            aria-label="Open navigation"
            aria-expanded={sidebarOpen}
          >
            <IconMenu size={18} />
          </button>

          <div className="min-w-0 flex-1">
            <Breadcrumbs />
          </div>

          <div className="relative" ref={notificationsRef}>
            <button
              type="button"
              onClick={() => setNotificationsOpen((open) => !open)}
              className="relative rounded p-1.5 text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
              aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
              aria-expanded={notificationsOpen}
              aria-haspopup="true"
            >
              <IconBell size={18} />
              {unread !== undefined && unread > 0 && (
                <span
                  aria-hidden="true"
                  className="tabular absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger-strong px-1 text-[10px] font-semibold leading-none text-white"
                >
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </button>

            {notificationsOpen && <NotificationPanel onClose={() => setNotificationsOpen(false)} />}
          </div>
        </header>

        <main id="main-content" className="min-w-0 flex-1 px-4 py-5 sm:px-6" tabIndex={-1}>
          {/* A page that throws loses only itself. Without this the whole tree
              unmounts and the user gets a white screen with no way out. Keyed on
              the pathname, so navigating away and back clears the error instead
              of leaving that page broken for the rest of the session. */}
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

/* ==========================================================================
   Sidebar
   ========================================================================== */

function Sidebar({
  open,
  sections,
  user,
  onClose,
  onLogout,
}: {
  open: boolean;
  sections: ReturnType<typeof navigationFor>;
  user: ReturnType<typeof useAuth>['user'];
  onClose: () => void;
  onLogout: () => void;
}) {
  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-line bg-surface',
        'transition-transform duration-200 ease-out lg:static lg:translate-x-0',
        open ? 'translate-x-0 shadow-popover lg:shadow-none' : '-translate-x-full',
      )}
      aria-label="Main navigation"
    >
      {/*
        The sidebar head is the one place the school's identity is permanent. It
        carries the school's name and the wordmark's descriptor line on a brand
        field, so it reads as a masthead rather than a nav bar with a logo
        dropped in.

        The `no-print` class matters: on paper this panel is hidden by the print
        rules in `index.css`, and the letterhead in the report takes over.
      */}
      <div className="no-print shrink-0 bg-brand-700 px-3 pb-3 pt-3 text-white">
        <div className="flex items-start justify-between gap-2">
          <Link to="/app" className="min-w-0 rounded focus-visible:outline-none">
            <Wordmark tone="light" />
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 -mt-1 shrink-0 rounded p-1 text-white/70 transition-colors hover:bg-surface/10 hover:text-white lg:hidden"
            aria-label="Close navigation"
          >
            <IconClose size={16} />
          </button>
        </div>
      </div>

      <nav className="no-print flex-1 overflow-y-auto px-2 py-3 scrollbar-thin">
        {sections.map((section) => (
          <div key={section.heading} className="mb-4 last:mb-0">
            <p className="eyebrow px-2 pb-1">{section.heading}</p>
            <ul className="space-y-px">
              {section.items.map((item) => {
                const Icon = ICONS[item.icon] ?? IconUser;
                return (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.end}
                      className={({ isActive }) =>
                        cn(
                          'group relative flex items-center gap-2.5 rounded px-2 py-1.5 text-sm transition-colors',
                          isActive
                            ? 'bg-brand-50 font-medium text-brand-800'
                            : 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          {/*
                            The active marker is a 2px rail, not a filled pill.
                            A filled background would compete with the data.
                          */}
                          <span
                            aria-hidden="true"
                            className={cn(
                              'absolute inset-y-1 left-0 w-0.5 rounded-full transition-colors',
                              isActive ? 'bg-brand-600' : 'bg-transparent',
                            )}
                          />
                          <Icon
                            size={16}
                            className={cn(
                              'shrink-0',
                              isActive ? 'text-brand-600' : 'text-ink-faint group-hover:text-ink-subtle',
                            )}
                          />
                          <span className="truncate">{item.label}</span>
                        </>
                      )}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <SidebarFooter user={user} onLogout={onLogout} />
    </aside>
  );
}

/* ==========================================================================
   Sidebar footer — academic year, identity, account menu
   ========================================================================== */

function SidebarFooter({
  user,
  onLogout,
}: {
  user: ReturnType<typeof useAuth>['user'];
  onLogout: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Everyone who can see students can see the academic year; it is orientation,
  // not administration.
  const { data: years } = useAcademicYears({
    includeArchived: false,
    enabled: Boolean(user) && can(user, PERMISSIONS.STUDENT_VIEW),
  });

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const currentYear = years?.current?.name;

  return (
    <div className="no-print shrink-0 border-t border-line">
      {currentYear && (
        <div className="flex items-center gap-2 border-b border-line-soft bg-app-raised px-3 py-2">
          <IconCalendar size={13} className="shrink-0 text-ink-faint" />
          <span className="min-w-0">
            <span className="block text-2xs uppercase tracking-wide text-ink-faint">Academic year</span>
            <span className="tabular block truncate text-xs font-medium text-ink">{currentYear}</span>
          </span>
        </div>
      )}

      <div className="relative p-2" ref={menuRef}>
        {menuOpen && (
          <div
            role="menu"
            className="popover-surface absolute bottom-full left-2 right-2 z-10 mb-1 overflow-hidden p-1"
          >
            <Link
              to="/app/profile"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
            >
              <IconUser size={15} />
              Profile and password
            </Link>
            {can(user, PERMISSIONS.USER_LIST) && (
              <Link
                to="/app/teachers"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
              >
                <IconUsers size={15} />
                Manage users
              </Link>
            )}
            <div className="my-1 border-t border-line-soft" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onLogout();
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-danger-strong transition-colors hover:bg-danger-soft"
            >
              <IconLogout size={15} />
              Sign out
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left transition-colors hover:bg-surface-sunken"
        >
          <span
            aria-hidden="true"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-2xs font-semibold text-ink-muted"
          >
            {user ? initialsOf(user.fullName) : '—'}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium leading-tight text-ink">
              {user?.fullName}
            </span>
            <span className="block truncate text-xs leading-tight text-ink-subtle">
              {roleLabel(user?.role)}
            </span>
          </span>
          <IconChevronDown
            size={13}
            className={cn('shrink-0 text-ink-faint transition-transform', menuOpen && 'rotate-180')}
          />
        </button>
      </div>
    </div>
  );
}

/* ==========================================================================
   Breadcrumbs
   ========================================================================== */

const SEGMENT_LABELS: Record<string, string> = {
  app: 'Dashboard',
  marks: 'Enter marks',
  review: 'Review',
  ocr: 'OCR',
  students: 'Students',
  import: 'Import',
  teachers: 'Teachers',
  'academic-years': 'Academic years',
  classes: 'Classes & sections',
  subjects: 'Subjects',
  exams: 'Exams',
  assignments: 'Assignments',
  'class-requests': 'Class requests',
  'my-classes': 'My classes',
  grading: 'Grading',
  reports: 'Reports',
  exports: 'Exports',
  audit: 'Audit log',
  settings: 'Settings',
  profile: 'Profile',
  account: 'Account',
};

/**
 * Breadcrumbs derive from the path.
 *
 * The last segment is a record id, not a name, so it is deliberately omitted: a
 * breadcrumb reading "… / marks / sub_1a2b3c" is noise. The page's own header
 * supplies the meaningful name.
 */
function Breadcrumbs() {
  const { pathname } = useLocation();
  const segments = pathname.split('/').filter(Boolean).slice(1);
  const meaningful = segments.filter(
    (segment) => SEGMENT_LABELS[segment] !== undefined || !/^(sub_|stu_|usr_|asg_|mk_|doc_)/.test(segment),
  );

  if (meaningful.length === 0) {
    return <p className="truncate text-sm font-medium text-ink">Dashboard</p>;
  }

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1 text-sm">
        {meaningful.map((segment, index) => {
          const to = `/app/${meaningful.slice(0, index + 1).join('/')}`;
          const isLast = index === meaningful.length - 1;
          const label =
            SEGMENT_LABELS[segment] ??
            segment.replace(/-/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());

          return (
            <li key={to} className="flex min-w-0 items-center gap-1">
              {index > 0 && (
                <span aria-hidden="true" className="text-ink-faint">
                  /
                </span>
              )}
              {isLast ? (
                <span aria-current="page" className="truncate font-medium text-ink">
                  {label}
                </span>
              ) : (
                <Link to={to} className="truncate text-ink-subtle transition-colors hover:text-ink">
                  {label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Re-exported so pages can render the icon set without a second import. */
export type { IconProps };
export type { ReactNode as ShellNode };
