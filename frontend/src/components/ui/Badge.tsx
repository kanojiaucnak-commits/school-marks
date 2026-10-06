import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import {
  CONFIDENCE_BANDS,
  confidenceBandOf,
  markStatus,
  ocrMatch,
  ocrStatus,
  submissionStatus,
  type StatusDescriptor,
  type Tone,
} from '../../lib/status';

/**
 * Badges and status pills.
 *
 * The design rule this file exists to enforce: **a status is never communicated
 * by colour alone.** Every badge renders an icon and a text label, so it reads
 * correctly for a colour-blind user, in a printed report, and in a screenshot
 * pasted into an email to a parent.
 *
 * Badges are also *quiet by default*. A table of forty submitted sheets should
 * look like forty rows of data, not forty competing chips. Colour is reserved
 * for the states that actually need action.
 */

export type { Tone } from '../../lib/status';

export interface BadgeProps {
  children: ReactNode;
  className?: string;
  size?: 'xs' | 'sm' | 'md';
  title?: string;
  tone?: Tone;
  /**
   * Legacy escape hatch for call sites that predate the descriptor API. Prefer
   * `tone`, or better `StatusBadge`, which also carries an icon.
   */
  dotClassName?: string;
}

/** Tailwind classes per tone, shared by every badge variant. */
const TONE_CLASS: Record<Tone, { text: string; bg: string; ring: string; border: string }> = {
  neutral: {
    text: 'text-ink-muted',
    bg: 'bg-surface-sunken',
    ring: 'ring-line',
    border: 'border-line',
  },
  info: { text: 'text-info-strong', bg: 'bg-info-soft', ring: 'ring-info-300', border: 'border-info-300' },
  success: {
    text: 'text-success-strong',
    bg: 'bg-success-soft',
    ring: 'ring-success-300',
    border: 'border-success-300',
  },
  warning: {
    text: 'text-warning-strong',
    bg: 'bg-warning-soft',
    ring: 'ring-warning-300',
    border: 'border-warning-300',
  },
  danger: {
    text: 'text-danger-strong',
    bg: 'bg-danger-soft',
    ring: 'ring-danger-300',
    border: 'border-danger-300',
  },
  sealed: {
    text: 'text-sealed-strong',
    bg: 'bg-sealed-soft',
    ring: 'ring-sealed-300',
    border: 'border-sealed-300',
  },
  accent: { text: 'text-brand-700', bg: 'bg-brand-50', ring: 'ring-brand-200', border: 'border-brand-200' },
};

export const toneClasses = (tone: Tone) => TONE_CLASS[tone];

const SIZES = {
  xs: 'gap-1 px-1.5 py-px text-2xs',
  sm: 'gap-1.5 px-2 py-0.5 text-xs',
  md: 'gap-1.5 px-2.5 py-1 text-sm',
} as const;

/**
 * Neutral label pill.
 *
 * Used for metadata — a subject code, a source, a count — never for a workflow
 * state. Workflow states get `StatusBadge`.
 */
export function Badge({ children, className, size = 'sm', title, tone = 'neutral', dotClassName }: BadgeProps) {
  const classes = TONE_CLASS[tone];
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center rounded font-medium ring-1 ring-inset',
        SIZES[size],
        classes.bg,
        classes.text,
        classes.ring,
        className,
      )}
    >
      {dotClassName && (
        <span aria-hidden="true" className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotClassName)} />
      )}
      {children}
    </span>
  );
}

/** Convenience wrapper for `<Badge tone={…}>`. */
export function ToneBadge({
  tone = 'neutral',
  children,
  title,
  className,
  size,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
  className?: string;
  size?: 'xs' | 'sm' | 'md';
}) {
  return (
    <Badge tone={tone} title={title} className={className} size={size}>
      {children}
    </Badge>
  );
}

/**
 * A workflow status.
 *
 * Icon + label + optional tooltip. This is the component that makes the safety
 * model visible: a teacher must be able to tell at a glance whether what they
 * are looking at is a draft, something a reviewer is checking, or a locked
 * permanent record.
 */
export function StatusBadge({
  descriptor,
  size = 'sm',
  showHelp = true,
  className,
}: {
  descriptor: StatusDescriptor;
  size?: 'xs' | 'sm' | 'md';
  /** Adds the explanation as a native tooltip. */
  showHelp?: boolean;
  className?: string;
}) {
  const Icon = descriptor.icon;
  const classes = TONE_CLASS[descriptor.tone];

  return (
    <span
      title={showHelp ? descriptor.help : undefined}
      className={cn(
        'inline-flex items-center rounded font-medium ring-1 ring-inset',
        SIZES[size],
        classes.bg,
        classes.text,
        classes.ring,
        className,
      )}
    >
      <Icon size={size === 'xs' ? 11 : 13} strokeWidth={2} />
      {descriptor.label}
    </span>
  );
}

/* ==========================================================================
   Workflow shorthands
   ========================================================================== */

export function SubmissionStatus({
  status,
  size = 'sm',
  showHelp = true,
  className,
}: {
  status: string | null | undefined;
  size?: 'xs' | 'sm' | 'md';
  showHelp?: boolean;
  className?: string;
}) {
  return (
    <StatusBadge
      descriptor={submissionStatus(status)}
      size={size}
      showHelp={showHelp}
      className={className}
    />
  );
}

export function OcrStatusBadge({
  status,
  size = 'sm',
  className,
}: {
  status: string | null | undefined;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}) {
  return (
    <StatusBadge descriptor={ocrStatus(status)} size={size} className={className} />
  );
}

export function MarkStatusBadge({
  status,
  size = 'xs',
  className,
}: {
  status: 'PRESENT' | 'ABSENT' | 'EXEMPTED' | 'MEDICAL';
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}) {
  return (
    <StatusBadge descriptor={markStatus(status)} size={size} className={className} />
  );
}

/**
 * How a row was matched to a student.
 *
 * An ambiguous or missing match is deliberately loud. Getting this wrong puts a
 * mark on the wrong child, which is the single worst outcome the product can
 * produce.
 */
export function MatchBadge({
  method,
  size = 'xs',
  className,
}: {
  method: string | null | undefined;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}) {
  const descriptor = ocrMatch(method);
  const classes = TONE_CLASS[descriptor.tone];
  const Icon = descriptor.icon;

  return (
    <span
      title={descriptor.help}
      className={cn(
        'inline-flex items-center rounded font-medium ring-1 ring-inset',
        SIZES[size],
        classes.bg,
        classes.text,
        classes.ring,
        // A match that still needs a human is allowed to look slightly heavier.
        descriptor.needsHuman && 'ring-2',
        className,
      )}
    >
      <Icon size={size === 'xs' ? 11 : 13} strokeWidth={2} />
      {descriptor.label}
    </span>
  );
}

/* ==========================================================================
   Confidence
   ========================================================================== */

/**
 * OCR confidence.
 *
 * Deliberately a short bar plus a word, not a large percentage badge. The
 * information a reviewer needs is "can I trust this or must I check it", and a
 * number dressed up as a KPI would overstate what OCR confidence actually means.
 */
export function ConfidenceIndicator({
  confidence,
  size = 'sm',
  showValue = true,
  className,
}: {
  confidence: number | null | undefined;
  size?: 'xs' | 'sm' | 'md';
  showValue?: boolean;
  className?: string;
}) {
  const band = CONFIDENCE_BANDS[confidenceBandOf(confidence)];
  const percent =
    confidence === null || confidence === undefined || Number.isNaN(confidence)
      ? 0
      : Math.round(confidence * 100);

  const heights = { xs: 'h-1 w-10', sm: 'h-1.5 w-14', md: 'h-2 w-20' };

  return (
    <span
      title={band.help}
      className={cn('inline-flex items-center gap-2', className)}
    >
      <span
        role="meter"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`OCR confidence: ${band.label.toLowerCase()}`}
        className={cn('shrink-0 overflow-hidden rounded-full bg-surface-sunken', heights[size])}
      >
        <span className={cn('block h-full rounded-full', band.meter)} style={{ width: `${percent}%` }} />
      </span>
      <span className={cn('whitespace-nowrap font-medium', band.text, size === 'xs' ? 'text-2xs' : 'text-xs')}>
        {showValue ? `${band.label} · ${percent}%` : band.label}
      </span>
    </span>
  );
}

/* ==========================================================================
   Counters
   ========================================================================== */

/**
 * A small count pill for a tab or a section heading.
 *
 * Neutral by default — a count is information, not a status.
 */
export function CountPill({
  value,
  tone = 'neutral',
  className,
}: {
  value: number | string;
  tone?: Tone;
  className?: string;
}) {
  const classes = TONE_CLASS[tone];
  return (
    <span
      className={cn(
        'tabular inline-flex min-w-[1.25rem] items-center justify-center rounded px-1 text-2xs font-semibold',
        classes.bg,
        classes.text,
        className,
      )}
    >
      {value}
    </span>
  );
}
