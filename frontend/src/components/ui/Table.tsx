import { useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { IconChevronDown, IconChevronsUpDown, IconChevronRight } from './icons';
import { EmptyList } from './States';
import { SectionHeader } from './Layout';

/**
 * Tables.
 *
 * Tables are most of this product, so they get the most attention.
 *
 * **Density over decoration.** No rounded cards wrapped around a table, no
 * shadow, no zebra striping. Structure comes from one hairline rule between
 * rows and a slightly stronger rule under the header. A user scanning 300
 * students should see data, not chrome.
 *
 * **The header is sticky.** On a long list the column meanings must stay
 * visible; losing them is what makes a dense table unusable.
 *
 * **Sorting is available but opt-in per column**, so the affordance appears only
 * on columns where it is actually wired up. A sort arrow on a column that does
 * not sort is worse than no arrow.
 */

export interface TableProps {
  children: ReactNode;
  className?: string;
  /** Announced to screen readers, e.g. "Student results". */
  caption?: string;
  /** Keeps the header visible while the body scrolls. */
  stickyHeader?: boolean;
  /** Caps the height and scrolls the body, with a sticky header inside. */
  maxHeight?: string;
}

export function Table({
  children,
  className,
  caption,
  stickyHeader = false,
  maxHeight,
}: TableProps) {
  return (
    <div
      className={cn(
        'overflow-x-auto scrollbar-thin',
        maxHeight && 'overflow-y-auto',
        className,
      )}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <table className={cn('w-full min-w-full border-collapse text-left', stickyHeader && 'text-sm')}>
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function THead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <thead className={cn('bg-app-raised', className)}>{children}</thead>
  );
}

/* ==========================================================================
   Sortable header cell
   ========================================================================== */

export interface SortState {
  key: string;
  direction: 'asc' | 'desc';
}

export function SortableTh({
  label,
  sortKey,
  sort,
  onSort,
  numeric,
  className,
  width,
}: {
  label: ReactNode;
  sortKey: string;
  sort: SortState | null;
  onSort: (key: string) => void;
  numeric?: boolean;
  className?: string;
  width?: string;
}) {
  const active = sort?.key === sortKey;
  const Icon = !active ? IconChevronsUpDown : sort.direction === 'asc' ? IconChevronDown : IconChevronRight;

  return (
    <th
      scope="col"
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      style={width ? { width } : undefined}
      className={cn(
        'border-b border-line px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle',
        numeric ? 'text-right' : 'text-left',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          'group -mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-ink',
          numeric && 'flex-row-reverse',
          active && 'text-ink',
        )}
      >
        {label}
        <Icon
          size={12}
          className={cn('shrink-0 transition-colors', active ? 'text-ink-muted' : 'text-ink-faint opacity-0 group-hover:opacity-100')}
        />
      </button>
    </th>
  );
}

/** Local sort state for a table that sorts in the browser. */
export function useSort(initial: SortState | null = null) {
  const [sort, setSort] = useState<SortState | null>(initial);

  const toggle = (key: string) => {
    setSort((current) => {
      if (current?.key !== key) return { key, direction: 'asc' };
      if (current.direction === 'asc') return { key, direction: 'desc' };
      return null;
    });
  };

  return { sort, toggle, setSort };
}

/** Applies the active sort to a list, treating missing values as lowest. */
export function applySort<T>(
  rows: T[],
  sort: SortState | null,
  accessors: Record<string, (row: T) => string | number | null | undefined>,
): T[] {
  if (!sort) return rows;
  const accessor = accessors[sort.key];
  if (!accessor) return rows;

  const direction = sort.direction === 'asc' ? 1 : -1;

  return [...rows].sort((a, b) => {
    const left = accessor(a);
    const right = accessor(b);

    // Missing values always sort last, whichever direction is active.
    if (left === null || left === undefined) return 1;
    if (right === null || right === undefined) return -1;

    if (typeof left === 'number' && typeof right === 'number') {
      return (left - right) * direction;
    }
    return String(left).localeCompare(String(right), undefined, { numeric: true }) * direction;
  });
}

/* ==========================================================================
   Cells
   ========================================================================== */

export function TH({
  children,
  className,
  scope = 'col',
  numeric,
  width,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean; width?: string }) {
  return (
    <th
      scope={scope}
      style={width ? { width } : undefined}
      className={cn(
        'border-b border-line bg-app-raised px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle',
        numeric ? 'text-right' : 'text-left',
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

export function TBody({ children, className }: { children: ReactNode; className?: string }) {
  return <tbody className={cn('divide-y divide-line-soft', className)}>{children}</tbody>;
}

export function TR({
  children,
  className,
  onClick,
  selected,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement> & { selected?: boolean }) {
  const interactive = Boolean(onClick);
  return (
    <tr
      onClick={onClick}
      // A clickable row must be reachable by keyboard, not just by mouse.
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick?.(event as unknown as React.MouseEvent<HTMLTableRowElement>);
              }
            }
          : undefined
      }
      aria-selected={selected}
      className={cn(
        'transition-colors',
        interactive && 'cursor-pointer hover:bg-brand-50/60 focus-visible:bg-brand-50/60',
        selected && 'bg-brand-50',
        className,
      )}
      {...props}
    >
      {children}
    </tr>
  );
}

export function TD({
  children,
  className,
  numeric,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td
      className={cn(
        'px-3 py-2 text-sm text-ink',
        numeric && 'tabular text-right',
        className,
      )}
      {...props}
    >
      {children}
    </td>
  );
}

/**
 * The identity cell: a name plus its secondary line.
 *
 * Most tables in this product lead with a person or a record, and the secondary
 * line is what makes it unambiguous — student number, admission number, email.
 */
export function IdentityCell({
  primary,
  secondary,
  trailing,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0">
        <p className="truncate font-medium text-ink">{primary}</p>
        {secondary && <p className="tabular truncate text-xs text-ink-subtle">{secondary}</p>}
      </div>
      {trailing && <div className="ml-auto shrink-0">{trailing}</div>}
    </div>
  );
}

/* ==========================================================================
   Pagination
   ========================================================================== */

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Rendered next to the range summary, e.g. a page-size selector. */
  extra?: ReactNode;
  className?: string;
}

/**
 * Page controls with a real range summary.
 *
 * Uses proper `<button>`s with chevron icons rather than `‹`/`›` glyphs, and
 * disables them at the boundaries so the state is visible rather than only
 * discovered by clicking.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  extra,
  className,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <nav
      aria-label="Pagination"
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 border-t border-line px-3 py-2.5',
        className,
      )}
    >
      <p className="tabular text-xs text-ink-muted" aria-live="polite">
        {total === 0 ? 'No results' : `${from}–${to} of ${total}`}
      </p>

      <div className="flex items-center gap-2">
        {extra}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
            className="inline-flex h-control-sm w-control-sm items-center justify-center rounded border border-line bg-surface text-ink-muted transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:border-transparent disabled:bg-transparent disabled:text-ink-faint"
          >
            <IconChevronRight size={14} className="rotate-180" />
          </button>
          <span className="tabular px-1 text-xs text-ink-muted">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            aria-label="Next page"
            className="inline-flex h-control-sm w-control-sm items-center justify-center rounded border border-line bg-surface text-ink-muted transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:border-transparent disabled:bg-transparent disabled:text-ink-faint"
          >
            <IconChevronRight size={14} />
          </button>
        </div>
      </div>
    </nav>
  );
}

/* ==========================================================================
   Tabs
   ========================================================================== */

export interface TabItem {
  id: string;
  label: string;
  count?: number | string;
  content: ReactNode;
}

/**
 * Tabs following the ARIA authoring pattern.
 *
 * Arrow keys move between tabs and roving `tabindex` keeps the tab list a single
 * tab stop, which is what a keyboard user expects from a tab bar.
 */
export function Tabs({
  items,
  activeId,
  onChange,
  className,
}: {
  items: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  const active = items.find((item) => item.id === activeId) ?? items[0];

  const move = (delta: number) => {
    const index = items.findIndex((item) => item.id === active?.id);
    const target = items[(index + delta + items.length) % items.length];
    if (target) {
      onChange(target.id);
      document.getElementById(`tab-${target.id}`)?.focus();
    }
  };

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-label="Sections"
        className="flex gap-1 overflow-x-auto border-b border-line scrollbar-thin"
      >
        {items.map((item) => {
          const selected = item.id === active?.id;
          return (
            <button
              key={item.id}
              id={`tab-${item.id}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(item.id)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight') {
                  event.preventDefault();
                  move(1);
                } else if (event.key === 'ArrowLeft') {
                  event.preventDefault();
                  move(-1);
                }
              }}
              className={cn(
                '-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                selected
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-ink-muted hover:border-line-strong hover:text-ink',
              )}
            >
              {item.label}
              {item.count !== undefined && item.count !== null && (
                <span
                  className={cn(
                    'tabular rounded px-1 py-px text-2xs font-semibold',
                    selected ? 'bg-brand-50 text-brand-700' : 'bg-surface-sunken text-ink-subtle',
                  )}
                >
                  {item.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {active && (
        <div
          id={`panel-${active.id}`}
          role="tabpanel"
          aria-labelledby={`tab-${active.id}`}
          tabIndex={0}
          className="pt-4 focus-visible:outline-none"
        >
          {active.content}
        </div>
      )}
    </div>
  );
}

/* ==========================================================================
   Empty table body
   ========================================================================== */

/**
 * An empty state rendered *inside* the table.
 *
 * Keeping it in the table body preserves the column headers, so the user can
 * still see what kind of list this is — which is the information a centred
 * empty state above the table throws away.
 */
export function TableEmpty({
  colSpan,
  title = 'Nothing to show',
  description,
  action,
  filtered = false,
}: {
  colSpan: number;
  title?: string;
  description?: string;
  action?: ReactNode;
  filtered?: boolean;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="p-0">
        <EmptyList
          title={title}
          description={description}
          action={action}
          filtered={filtered}
        />
      </td>
    </tr>
  );
}

/* ==========================================================================
   Compatibility shims
   ==========================================================================
   The pre-redesign `Card` / `CardHeader` / `StatTile` pair is still imported by
   several admin pages. They now delegate to the new layout primitives so the
   whole app inherits the new spacing and surface rules immediately.
   -------------------------------------------------------------------------- */

export interface CardProps {
  children: ReactNode;
  className?: string;
  flush?: boolean;
  raised?: boolean;
}

export function Card({ children, className, flush, raised }: CardProps) {
  return (
    <section className={cn(raised ? 'popover-surface' : 'card-surface', !flush && 'p-4', className)}>
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return <SectionHeader title={title} description={description} actions={actions} className={className} />;
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
  icon,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
  icon?: ReactNode;
  className?: string;
}) {
  const valueTone = {
    neutral: 'text-ink',
    accent: 'text-brand-700',
    success: 'text-success-strong',
    warning: 'text-warning-strong',
    danger: 'text-danger-strong',
  }[tone];

  return (
    <div className={cn('card-surface p-4', className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-ink-subtle">{label}</p>
        {icon && (
          <span aria-hidden="true" className="text-ink-faint">
            {icon}
          </span>
        )}
      </div>
      <p className={cn('tabular mt-1.5 text-2xl font-semibold leading-none', valueTone)}>{value}</p>
      {hint && <p className="mt-1.5 text-xs text-ink-subtle">{hint}</p>}
    </div>
  );
}
