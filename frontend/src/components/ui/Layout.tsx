import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * Page structure.
 *
 * These four components are what stop a dashboard turning into a wall of
 * identical cards. They encode the hierarchy a page should have:
 *
 *   PageHeader    one title, one line of context, a small set of actions
 *   SectionHeader a heading inside the page, optional count and actions
 *   DataToolbar   search + filters + a result count, in one row
 *   Panel         a data surface — table or grid, no shadow, hairline border
 *
 * The rule the whole file exists to enforce: **not everything is a card.** A
 * panel that holds a table is a table. Chrome is reserved for things that need
 * to be distinguished from the page background, and even then it is a 1px
 * border with no shadow.
 */

/* ==========================================================================
   Page header
   ========================================================================== */

export interface PageHeaderProps {
  title: string;
  /** One line of context. Answers "what am I looking at?", not "what is this?" */
  description?: ReactNode;
  /**
   * The primary action, placed first and given the primary style.
   * Keep this to one — if a page has two equally important actions it is really
   * two pages.
   */
  primaryAction?: ReactNode;
  /** Secondary actions, always to the right of the primary. */
  actions?: ReactNode;
  /** Rendered under the actions row: filters, tabs, context chips. */
  children?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  primaryAction,
  actions,
  children,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn('mb-5', className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="page-title">{title}</h1>
          {description && (
            <p className="mt-1 max-w-prose text-sm text-ink-muted">{description}</p>
          )}
        </div>

        {(primaryAction || actions) && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
            {primaryAction}
          </div>
        )}
      </div>

      {children && <div className="mt-4">{children}</div>}
    </header>
  );
}

/* ==========================================================================
   Section header
   ========================================================================== */

export interface SectionHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** A count rendered next to the title, e.g. "Draft (4)". */
  count?: ReactNode;
  /** Visual weight. Use `bordered` when the section is a distinct region. */
  variant?: 'plain' | 'bordered';
  className?: string;
  children?: ReactNode;
}

export function SectionHeader({
  title,
  description,
  actions,
  count,
  variant = 'plain',
  className,
  children,
}: SectionHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-x-4 gap-y-2',
        variant === 'bordered' && 'border-b border-line px-4 py-3',
        className,
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {count !== undefined && count !== null && (
            <span className="tabular text-xs font-normal text-ink-subtle">{count}</span>
          )}
        </div>
        {description && <p className="mt-0.5 text-xs text-ink-muted">{description}</p>}
        {children}
      </div>

      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ==========================================================================
   Data toolbar
   ========================================================================== */

/**
 * Search, filters and the result count, on one line.
 *
 * Placing the count here rather than in the table footer means the user can see
 * "24 of 310 students" without scrolling, which is the actual question when
 * searching a school-sized list.
 */
export interface DataToolbarProps {
  children?: ReactNode;
  /** Right-aligned slot for view options, export, column toggles. */
  trailing?: ReactNode;
  className?: string;
}

export function DataToolbar({ children, trailing, className }: DataToolbarProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2.5',
        className,
      )}
    >
      {children}
      {trailing && <div className="ml-auto flex items-center gap-2">{trailing}</div>}
    </div>
  );
}

/* ==========================================================================
   Panel
   ========================================================================== */

export interface PanelProps {
  children: ReactNode;
  className?: string;
  /** Removes padding — use when the panel wraps a table directly. */
  flush?: boolean;
  /** Lifts the panel off the page. Reserve for menus and genuinely transient UI. */
  raised?: boolean;
  as?: 'section' | 'div' | 'article' | 'aside';
}

/**
 * A data surface.
 *
 * `shadow-card` is deliberately absent. Elevation on a page of panels creates a
 * visual hierarchy based on nothing more than nesting, and the eye then reads
 * the loudest shadow as the most important thing — which is not what this
 * product needs.
 */
export function Panel({ children, className, flush, raised, as: Tag = 'section' }: PanelProps) {
  return (
    <Tag
      className={cn(
        raised ? 'popover-surface' : 'card-surface',
        !flush && 'p-4',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/**
 * Panel with a header row.
 *
 * This is the workhorse the admin pages use, replacing the old
 * `Card` + `CardHeader` pair with one component that gets the spacing right.
 */
export function TitledPanel({
  title,
  description,
  actions,
  children,
  flush = true,
  count,
  className,
  headerClassName,
  bodyClassName,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  count?: ReactNode;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('card-surface', className)}>
      <SectionHeader
        title={title}
        description={description}
        actions={actions}
        count={count}
        variant="bordered"
        className={cn('bg-app-raised', headerClassName)}
      />
      <div className={cn(flush ? '' : 'p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/**
 * Two-column definition row, used for detail pages.
 *
 * A student has a dozen fields. Laying them out as cards wastes the screen and
 * hides the relationships; a labelled definition list lets a user scan a whole
 * record in one pass.
 */
export function DescriptionList({
  items,
  columns = 2,
  className,
}: {
  items: Array<{ label: string; value: ReactNode; span?: boolean }>;
  columns?: 1 | 2 | 3;
  className?: string;
}) {
  const grid = {
    1: 'sm:grid-cols-1',
    2: 'sm:grid-cols-2',
    3: 'sm:grid-cols-2 lg:grid-cols-3',
  }[columns];

  return (
    <dl className={cn('grid grid-cols-1 gap-x-6 gap-y-3', grid, className)}>
      {items.map((item) => (
        <div key={item.label} className={cn('min-w-0', item.span && 'sm:col-span-full')}>
          <dt className="text-xs font-medium text-ink-subtle">{item.label}</dt>
          <dd className="mt-0.5 truncate text-sm text-ink" title={typeof item.value === 'string' ? item.value : undefined}>
            {item.value ?? '—'}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A single figure with its label.
 *
 * Not a "stat card" with an icon and a border — those multiply quickly and stop
 * meaning anything. A figure is a number and a caption, set inline with enough
 * rhythm that a row of them reads as one group.
 */
export function Figure({
  label,
  value,
  hint,
  tone = 'neutral',
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent' | 'sealed';
  className?: string;
}) {
  const valueTone = {
    neutral: 'text-ink',
    success: 'text-success-strong',
    warning: 'text-warning-strong',
    danger: 'text-danger-strong',
    accent: 'text-brand-700',
    sealed: 'text-sealed-strong',
  }[tone];

  return (
    <div className={cn('min-w-0', className)}>
      <p className="truncate text-xs text-ink-subtle">{label}</p>
      <p className={cn('tabular mt-0.5 text-lg font-semibold leading-tight', valueTone)}>{value}</p>
      {hint && <p className="mt-0.5 text-2xs text-ink-faint">{hint}</p>}
    </div>
  );
}

/**
 * A row of related figures, divided rather than boxed.
 *
 * Separators instead of cards: five numbers in five cards is five times the
 * visual noise of five numbers in one strip.
 */
export function FigureRow({
  items,
  className,
}: {
  items: Array<React.ComponentProps<typeof Figure>>;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5',
        '[&>*:not(:first-child)]:lg:border-l [&>*:not(:first-child)]:lg:border-line [&>*:not(:first-child)]:lg:pl-6',
        className,
      )}
    >
      {items.map((item) => (
        <Figure key={item.label} {...item} />
      ))}
    </div>
  );
}

/**
 * A labelled list of things needing attention.
 *
 * This replaces the "dashboard full of statistic cards" pattern. The unit is a
 * *task* with a subject, a state and one action — not a number.
 */
export function ActionList({
  items,
  emptyState,
  className,
}: {
  items: Array<{
    id: string;
    title: ReactNode;
    meta?: ReactNode;
    status?: ReactNode;
    action?: ReactNode;
  }>;
  emptyState?: ReactNode;
  className?: string;
}) {
  if (items.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <ul className={cn('divide-y divide-line-soft', className)}>
      {items.map((item) => (
        <li key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink">{item.title}</p>
            {item.meta && <p className="tabular mt-0.5 truncate text-xs text-ink-muted">{item.meta}</p>}
          </div>
          {item.status}
          {item.action}
        </li>
      ))}
    </ul>
  );
}

/**
 * A compact activity feed: who, what, which record, when.
 *
 * Deliberately a table-like list rather than a timeline with dots and lines. The
 * question an admin asks of an audit feed is "who touched this and when", which
 * is tabular data, not a story.
 */
export function ActivityFeed({
  items,
  className,
}: {
  items: Array<{
    id: string;
    actor: ReactNode;
    action: ReactNode;
    entity?: ReactNode;
    time: ReactNode;
  }>;
  className?: string;
}) {
  return (
    <ul className={cn('divide-y divide-line-soft', className)}>
      {items.map((item) => (
        <li key={item.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 py-2 text-sm">
          <span className="font-medium text-ink">{item.actor}</span>
          <span className="text-ink-muted">{item.action}</span>
          {item.entity && <span className="min-w-0 truncate text-ink-subtle">{item.entity}</span>}
          <span className="tabular ml-auto shrink-0 text-xs text-ink-faint">{item.time}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A thin proportional bar.
 *
 * Only for a single part-to-whole where the proportion *is* the answer
 * (completion, coverage). A decorative progress ring on a dashboard answers
 * nothing, so this component is deliberately the only such affordance in the
 * system and it always carries a number alongside it.
 */
export function Meter({
  value,
  max = 100,
  label,
  valueLabel,
  tone = 'accent',
  className,
}: {
  value: number;
  max?: number;
  label: string;
  valueLabel?: ReactNode;
  tone?: 'accent' | 'success' | 'warning' | 'danger';
  className?: string;
}) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const bar = {
    accent: 'bg-brand-500',
    success: 'bg-success-500',
    warning: 'bg-warning-500',
    danger: 'bg-danger-500',
  }[tone];

  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-ink-muted">{label}</span>
        <span className="tabular text-xs font-medium text-ink">{valueLabel ?? `${Math.round(percent)}%`}</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken"
      >
        <div className={cn('h-full rounded-full transition-[width] duration-300', bar)} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
