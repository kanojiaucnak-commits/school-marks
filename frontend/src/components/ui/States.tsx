import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import {
  IconAlertCircle,
  IconCheck,
  IconChevronRight,
  IconInbox,
  IconInfo,
  IconLock,
  IconX,
} from './icons';
import type { Tone } from '../../lib/status';
import { toneClasses } from './Badge';

/**
 * Loading, empty, error and status states.
 *
 * Two rules run through this file.
 *
 * **A blank screen is never ambiguous.** Every data view renders exactly one of
 * these, so the user always knows whether the app is loading, empty, or broken —
 * and in the empty case, what to do next.
 *
 * **No emoji.** Status is carried by an icon from the shared family and by text,
 * because an emoji renders differently on every platform and reads as decoration
 * rather than as state.
 */

/* ==========================================================================
   Spinner
   ========================================================================== */

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span role="status" aria-live="polite" className={cn('inline-flex items-center gap-2', className)}>
      <span
        aria-hidden="true"
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
      />
      <span className="sr-only">{label ?? 'Loading'}</span>
      {label && <span className="text-sm text-ink-muted">{label}</span>}
    </span>
  );
}

/* ==========================================================================
   Loading
   ========================================================================== */

export function LoadingState({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('flex items-center justify-center gap-3 py-16 text-ink-muted', className)}
    >
      <span
        aria-hidden="true"
        className="h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-brand-600"
      />
      <p className="text-sm">{label}</p>
    </div>
  );
}

/**
 * Skeleton rows that match the real table's geometry.
 *
 * Deliberately not a centred spinner: replacing a table with a spinner makes the
 * page jump and destroys the user's sense of where they are. Skeletons keep the
 * layout stable, which matters more on a list they were halfway down.
 */
export function TableSkeleton({ rows = 8, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading data</span>
      <div className="flex gap-4 border-b border-line bg-app-raised px-3 py-2.5">
        {Array.from({ length: columns }).map((_, index) => (
          <div key={index} className="skeleton h-3 flex-1" style={{ maxWidth: index === 0 ? '20%' : undefined }} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex gap-4 border-b border-line-soft px-3 py-2.5">
          {Array.from({ length: columns }).map((__, columnIndex) => (
            <div
              key={columnIndex}
              className="skeleton h-4 flex-1"
              // The first column is a name and reads wider; matching the real
              // geometry stops the list shifting when data lands.
              style={{ maxWidth: columnIndex === 0 ? '24%' : undefined }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Skeleton for a row of figures or a summary strip. */
export function FigureSkeleton({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cn('grid grid-cols-2 gap-6 sm:grid-cols-4', className)}>
      <span className="sr-only">Loading</span>
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="space-y-2">
          <div className="skeleton h-3 w-20" />
          <div className="skeleton h-5 w-12" />
        </div>
      ))}
    </div>
  );
}

export function PanelSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div role="status" aria-live="polite" className={cn('card-surface space-y-3 p-4', className)}>
      <span className="sr-only">Loading</span>
      <div className="skeleton h-3.5 w-40" />
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-3">
          <div className="skeleton h-4 flex-1" />
          <div className="skeleton h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

/* ==========================================================================
   Empty state
   ========================================================================== */

export interface EmptyStateProps {
  title: string;
  /**
   * Explains *why* it is empty and what happens next. "No data" is not an
   * explanation; "No mark sheets have been created for this academic year" is.
   */
  description?: ReactNode;
  icon?: ReactNode;
  /** The one action that resolves the empty state, if the user can take it. */
  action?: ReactNode;
  /** Renders a tighter variant, for empty states inside a table body. */
  size?: 'sm' | 'md';
  className?: string;
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  size = 'md',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        size === 'md' ? 'gap-3 px-6 py-12' : 'gap-2 px-4 py-8',
        className,
      )}
    >
      {icon && (
        <span
          aria-hidden="true"
          className={cn(
            'flex items-center justify-center rounded-full bg-surface-sunken text-ink-faint',
            size === 'md' ? 'h-10 w-10' : 'h-8 w-8',
          )}
        >
          {icon}
        </span>
      )}
      <div className="max-w-md">
        <p className={cn('font-medium text-ink', size === 'md' ? 'text-sm' : 'text-xs')}>{title}</p>
        {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * The empty state for a permission-gated list.
 *
 * Distinguishing "you have nothing" from "you cannot see this" matters: showing
 * an empty table to a teacher who lacks a permission reads as a bug.
 */
export function NoAccessState({
  title = 'You do not have access to this',
  description = 'Ask an administrator if you need this information.',
}: {
  title?: string;
  description?: string;
}) {
  return (
    <EmptyState
      icon={<IconLock size={18} />}
      title={title}
      description={description}
    />
  );
}

/* ==========================================================================
   Error state
   ========================================================================== */

export interface ErrorStateProps {
  title?: string;
  /**
   * What failed, in plain language. Prefer `QueryError.userMessage`, which is
   * always safe to render.
   */
  message: string;
  /** What the user can do about it. Strongly preferred — see the notes below. */
  hint?: ReactNode;
  onRetry?: () => void;
  className?: string;
}

/**
 * Full-surface error.
 *
 * The retry button only appears when there is genuinely something to retry; a
 * "Try again" on a 403 the user cannot fix is a dead end dressed as an offer.
 */
export function ErrorState({
  title = 'Something went wrong',
  message,
  hint,
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'mx-auto flex max-w-lg flex-col items-center gap-3 px-6 py-12 text-center',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="flex h-10 w-10 items-center justify-center rounded-full bg-danger-soft text-danger-strong"
      >
        <IconAlertCircle size={20} />
      </span>
      <div>
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="mt-1 text-sm text-ink-muted">{message}</p>
        {hint && <div className="mt-2 text-sm text-ink-subtle">{hint}</div>}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 inline-flex h-control items-center gap-1.5 rounded border border-line bg-surface px-3 text-sm font-medium text-ink transition-colors hover:bg-surface-muted"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/* ==========================================================================
   Inline alert / callout
   ========================================================================== */

export interface AlertProps {
  tone?: Tone;
  title?: string;
  children: ReactNode;
  className?: string;
  onDismiss?: () => void;
  /**
   * A single action, e.g. "Reload". Alerts that can be acted on should not make
   * the user hunt for the control.
   */
  action?: ReactNode;
}

const ALERT_ICON: Partial<Record<Tone, ReactNode>> = {
  neutral: <IconInfo size={16} />,
  info: <IconInfo size={16} />,
  success: <IconCheck size={16} />,
  warning: <IconAlertCircle size={16} />,
  danger: <IconAlertCircle size={16} />,
  sealed: <IconLock size={16} />,
  accent: <IconInfo size={16} />,
};

/**
 * Inline message.
 *
 * Colour is the *last* cue, not the first: there is an icon, and `danger`
 * alerts use `role="alert"` so they interrupt a screen reader rather than
 * waiting politely in the queue.
 */
export function Alert({ tone = 'info', title, children, className, onDismiss, action }: AlertProps) {
  const classes = toneClasses(tone);

  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2.5 rounded border px-3 py-2.5 text-sm',
        classes.border,
        classes.bg,
        classes.text,
        className,
      )}
    >
      <span aria-hidden="true" className="mt-px shrink-0">
        {ALERT_ICON[tone]}
      </span>
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        <div className={cn(title && 'mt-0.5', 'text-[0.9375rem] leading-relaxed')}>{children}</div>
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mr-1 shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
        >
          <IconX size={14} />
        </button>
      )}
    </div>
  );
}

/**
 * A neutral note.
 *
 * Used to explain a constraint the user is about to hit, before they hit it —
 * "OCR values are suggestions; you verify each one". This is where the safety
 * model gets taught rather than enforced.
 */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('flex items-start gap-2 text-xs text-ink-subtle', className)}>
      <IconInfo size={13} className="mt-px shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/**
 * The empty inbox state used by list pages.
 *
 * Split out because it recurs: an empty list that has never been populated reads
 * very differently from one whose contents were filtered away, and the wording
 * should match which of those happened.
 */
export function EmptyList({
  title = 'Nothing here yet',
  description,
  action,
  filtered = false,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  /** Adjusts the wording when a search or filter is responsible for the blank. */
  filtered?: boolean;
}) {
  return (
    <EmptyState
      icon={filtered ? <IconChevronRight size={16} /> : <IconInbox size={18} />}
      title={filtered ? 'No results match these filters' : title}
      description={
        filtered
          ? 'Try a different search term, or clear the filters to see everything.'
          : description
      }
      action={action}
      size="sm"
    />
  );
}
