import type { ComponentType, ReactNode } from 'react';
import {
  OCR_STATUS,
  SUBMISSION_STATUS,
  type MarkStatus,
  type OcrMatchMethod,
  type SubmissionStatus,
} from '@school/shared';
import {
  IconAlert,
  IconAlertCircle,
  IconCheck,
  IconCheckCircle,
  IconClock,
  IconEdit,
  IconEye,
  IconFileSearch,
  IconInbox,
  IconLock,
  IconMinus,
  IconScan,
  IconShield,
  IconTarget,
  IconUserCheck,
  IconUsers,
  IconX,
  IconXCircle,
  type IconProps,
} from '../components/ui/icons';

/**
 * The status vocabulary.
 *
 * This is the single place a workflow state acquires a meaning, a colour and an
 * icon. Three rules hold everywhere:
 *
 *  1. **Never colour alone.** Every status renders an icon *and* a text label,
 *     so it survives colour-blindness, a monochrome printout and a screenshot in
 *     a parent-teacher email.
 *  2. **One meaning per state.** `APPROVED` and `LOCKED` are never the same
 *     colour: approved means "someone checked this", locked means "this is now
 *     a permanent record". Collapsing them would hide the most important
 *     distinction in the product.
 *  3. **`help` explains the consequence**, not the definition. A badge that says
 *     "Draft" is obvious; one whose tooltip says "Not yet submitted — nobody has
 *     checked this" tells the user why they should care.
 */

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'sealed' | 'accent';

export interface StatusDescriptor {
  /** What the user reads. Sentence case, never shouted. */
  label: string;
  tone: Tone;
  icon: ComponentType<IconProps>;
  /** One sentence on what this state means for the marks. */
  help: string;
}

/* ==========================================================================
   Mark sheet workflow — the spine of the product
   ========================================================================== */

export const SUBMISSION_STATUS_MAP: Record<string, StatusDescriptor> = {
  [SUBMISSION_STATUS.DRAFT]: {
    label: 'Draft',
    tone: 'neutral',
    icon: IconEdit,
    help: 'Still being entered. Nobody has seen these marks yet.',
  },
  [SUBMISSION_STATUS.SUBMITTED]: {
    label: 'Submitted',
    tone: 'warning',
    icon: IconClock,
    help: 'Waiting for a reviewer to pick it up.',
  },
  [SUBMISSION_STATUS.UNDER_REVIEW]: {
    label: 'Under review',
    tone: 'info',
    icon: IconEye,
    help: 'A reviewer is checking these marks right now.',
  },
  [SUBMISSION_STATUS.APPROVED]: {
    label: 'Approved',
    tone: 'success',
    icon: IconCheck,
    help: 'Checked and accepted. Can still be corrected by a reviewer.',
  },
  [SUBMISSION_STATUS.LOCKED]: {
    label: 'Locked',
    tone: 'sealed',
    icon: IconLock,
    help: 'A permanent record. Only a reviewer can correct it, with a written reason.',
  },
  [SUBMISSION_STATUS.RETURNED]: {
    label: 'Returned',
    tone: 'warning',
    icon: IconUndoIcon,
    help: 'Sent back to the teacher for correction.',
  },
  [SUBMISSION_STATUS.REJECTED]: {
    label: 'Rejected',
    tone: 'danger',
    icon: IconXCircle,
    help: 'Discarded. The marks will not be published.',
  },
};

/** Arrow returning left — used only by RETURNED, so it lives next to its use. */
function IconUndoIcon(p: IconProps) {
  return (
    <IconRotateBack {...p} />
  );
}
function IconRotateBack(p: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={p.size ?? 18}
      height={p.size ?? 18}
      fill="none"
      stroke="currentColor"
      strokeWidth={p.strokeWidth ?? 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={p.className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  );
}

/* ==========================================================================
   OCR pipeline
   ========================================================================== */

export const OCR_STATUS_MAP: Record<string, StatusDescriptor> = {
  [OCR_STATUS.UPLOADED]: {
    label: 'Uploaded',
    tone: 'neutral',
    icon: IconFileSearch,
    help: 'Stored privately. Reading has not started yet.',
  },
  [OCR_STATUS.QUEUED]: {
    label: 'Queued',
    tone: 'neutral',
    icon: IconClock,
    help: 'Waiting for extraction to finish.',
  },
  [OCR_STATUS.PROCESSING]: {
    label: 'Reading document',
    tone: 'info',
    icon: IconScan,
    help: 'Extracting text and marks. Nothing has been saved yet.',
  },
  [OCR_STATUS.COMPLETED]: {
    label: 'Needs verification',
    tone: 'warning',
    icon: IconEye,
    help: 'Values were extracted. A person must check each one before it counts.',
  },
  [OCR_STATUS.FAILED]: {
    label: 'Failed',
    tone: 'danger',
    icon: IconAlert,
    help: 'The document could not be read. Retry, or enter the marks by hand.',
  },
  [OCR_STATUS.CONFIRMED]: {
    label: 'Saved as draft',
    tone: 'success',
    icon: IconCheckCircle,
    help: 'Verified rows were written to a draft sheet. Still needs submitting.',
  },
  [OCR_STATUS.CANCELLED]: {
    label: 'Cancelled',
    tone: 'neutral',
    icon: IconMinus,
    help: 'Processing was stopped. Nothing was saved.',
  },
};

/**
 * How a row was matched to a student.
 *
 * `AMBIGUOUS` and `NONE` get their own descriptors rather than sharing
 * "unmatched", because the required action differs: an ambiguous row needs a
 * choice between named candidates, an unmatched row needs a search.
 *
 * `student_id` is legacy: `matchRow` no longer identifies a student from their
 * student or admission number, but rows matched before that rule changed are
 * still readable here rather than falling through to "Not matched".
 */
export const OCR_MATCH_MAP: Record<string, StatusDescriptor & { needsHuman: boolean }> = {
  student_id: {
    label: 'Matched by student number',
    tone: 'success',
    icon: IconTarget,
    help: 'The student number on the sheet matched exactly.',
    needsHuman: false,
  },
  roll_number: {
    label: 'Matched by roll number',
    tone: 'success',
    icon: IconHashIcon,
    help: 'The roll number on the sheet matched one student in this section.',
    needsHuman: false,
  },
  normalized_name: {
    label: 'Matched by name',
    tone: 'success',
    icon: IconUsers,
    help: 'The name matched one student in this section.',
    needsHuman: false,
  },
  fuzzy_name: {
    label: 'Matched by similar name',
    tone: 'warning',
    icon: IconUserCheck,
    help: 'The name was close but not identical. Check it is the right student.',
    needsHuman: true,
  },
  manual: {
    label: 'Matched by hand',
    tone: 'info',
    icon: IconUserCheck,
    help: 'A person chose this student from the list.',
    needsHuman: false,
  },
  none: {
    label: 'Not matched',
    tone: 'danger',
    icon: IconX,
    help: 'No confident match. Choose a student before this row can be saved.',
    needsHuman: true,
  },
};

function IconHashIcon(p: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={p.size ?? 18}
      height={p.size ?? 18}
      fill="none"
      stroke="currentColor"
      strokeWidth={p.strokeWidth ?? 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={p.className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 9h14M5 15h14M10 3.5 8.5 20.5M15.5 3.5 14 20.5" />
    </svg>
  );
}

/* ==========================================================================
   Per-student mark status
   ========================================================================== */

export const MARK_STATUS_MAP: Record<MarkStatus, StatusDescriptor> = {
  PRESENT: {
    label: 'Present',
    tone: 'neutral',
    icon: IconCheck,
    help: 'Sat the exam and was awarded a mark.',
  },
  ABSENT: {
    label: 'Absent',
    tone: 'warning',
    icon: IconMinus,
    help: 'Did not sit the exam. Not a zero.',
  },
  EXEMPTED: {
    label: 'Exempted',
    tone: 'info',
    icon: IconShield,
    help: 'Not required to sit this exam.',
  },
  MEDICAL: {
    label: 'Medical',
    tone: 'info',
    icon: IconShield,
    help: 'Excused on medical grounds. Excluded from the pass calculation.',
  },
};

/* ==========================================================================
   OCR confidence
   ========================================================================== */

export type ConfidenceBand = 'high' | 'medium' | 'low' | 'unknown';

export const CONFIDENCE_BANDS: Record<
  ConfidenceBand,
  { label: string; tone: Tone; help: string; meter: string; text: string }
> = {
  high: {
    label: 'High confidence',
    tone: 'success',
    help: 'Read clearly. Still verify it — OCR is never trusted automatically.',
    meter: 'bg-success-500',
    text: 'text-success-700',
  },
  medium: {
    label: 'Check this one',
    tone: 'warning',
    help: 'Read with some uncertainty. Compare against the scan before accepting.',
    meter: 'bg-warning-500',
    text: 'text-warning-700',
  },
  low: {
    label: 'Low confidence',
    tone: 'danger',
    help: 'The scan was unclear. Expect to type this value yourself.',
    meter: 'bg-danger-500',
    text: 'text-danger-700',
  },
  unknown: {
    label: 'Unknown',
    tone: 'neutral',
    help: 'No confidence score was returned for this row.',
    meter: 'bg-muted-400',
    text: 'text-ink-subtle',
  },
};

/* ==========================================================================
   Lookups
   ========================================================================== */

const FALLBACK: StatusDescriptor = {
  label: 'Unknown',
  tone: 'neutral',
  icon: IconAlertCircle,
  help: 'This state is not recognised.',
};

export function submissionStatus(status: string | null | undefined): StatusDescriptor {
  return SUBMISSION_STATUS_MAP[status ?? ''] ?? FALLBACK;
}

export function ocrStatus(status: string | null | undefined): StatusDescriptor {
  return OCR_STATUS_MAP[status ?? ''] ?? FALLBACK;
}

export function markStatus(status: MarkStatus | null | undefined): StatusDescriptor {
  return MARK_STATUS_MAP[status ?? 'PRESENT'] ?? MARK_STATUS_MAP.PRESENT;
}

export function ocrMatch(method: OcrMatchMethod | string | null | undefined) {
  return OCR_MATCH_MAP[method ?? 'none'] ?? OCR_MATCH_MAP.none!;
}

/** Maps a 0–1 confidence to its band, using the OCR_CONFIDENCE thresholds. */
export function confidenceBandOf(confidence: number | null | undefined): ConfidenceBand {
  if (confidence === null || confidence === undefined || Number.isNaN(confidence)) return 'unknown';
  if (confidence >= 0.9) return 'high';
  if (confidence >= 0.7) return 'medium';
  return 'low';
}

/* ==========================================================================
   Compatibility shims
   ==========================================================================
   These keep the pre-redesign call sites compiling while they are migrated to
   the descriptor API. New code should use the lookups above.
   -------------------------------------------------------------------------- */

const TONE_CLASS: Record<Tone, { className: string; dotClassName: string }> = {
  neutral: { className: 'bg-muted-soft text-muted-strong ring-line-strong', dotClassName: 'bg-muted-base' },
  info: { className: 'bg-info-soft text-info-strong ring-info-300', dotClassName: 'bg-info-base' },
  success: { className: 'bg-success-soft text-success-strong ring-success-300', dotClassName: 'bg-success-base' },
  warning: { className: 'bg-warning-soft text-warning-strong ring-warning-300', dotClassName: 'bg-warning-base' },
  danger: { className: 'bg-danger-soft text-danger-strong ring-danger-300', dotClassName: 'bg-danger-base' },
  sealed: { className: 'bg-sealed-soft text-sealed-strong ring-sealed-300', dotClassName: 'bg-sealed-base' },
  accent: { className: 'bg-brand-50 text-brand-800 ring-brand-300', dotClassName: 'bg-brand-500' },
};

/** Legacy shape kept for `SUBMISSION_STATUS_STYLES` and `OCR_STATUS_STYLES`. */
export function toStyle(descriptor: StatusDescriptor): {
  label: string;
  className: string;
  dotClassName: string;
} {
  return { label: descriptor.label, ...TONE_CLASS[descriptor.tone] };
}

export const SUBMISSION_STATUS_STYLES: Record<SubmissionStatus, ReturnType<typeof toStyle>> =
  Object.fromEntries(
    Object.entries(SUBMISSION_STATUS_MAP).map(([key, value]) => [key, toStyle(value)]),
  ) as Record<SubmissionStatus, ReturnType<typeof toStyle>>;

export const OCR_STATUS_STYLES: Record<string, ReturnType<typeof toStyle>> = Object.fromEntries(
  Object.entries(OCR_STATUS_MAP).map(([key, value]) => [key, toStyle(value)]),
);

export interface StatusTone {
  label: string;
  className: string;
  dotClassName: string;
}

/** Legacy confidence helper: returns a tone object plus a ring colour. */
export function confidenceStyle(confidence: number | null): StatusTone & { ring: string } {
  const band = confidenceBandOf(confidence);
  const percent = confidence === null || confidence === undefined ? null : Math.round(confidence * 100);

  const suffix = percent === null ? '' : ` · ${band === 'high' ? 'high' : band === 'medium' ? 'check' : 'verify'}`;
  const base = toStyle({
    label: `${percent === null ? 'Unknown' : `${percent}%`}${suffix}`,
    tone: CONFIDENCE_BANDS[band].tone,
    icon: IconAlertCircle,
    help: CONFIDENCE_BANDS[band].help,
  });

  return { ...base, ring: `ring-${band === 'unknown' ? 'slate' : band}-300` };
}

/** Marks that need attention before a sheet can be confirmed. */
export function needsAttention(confidence: number | null): boolean {
  const band = confidenceBandOf(confidence);
  return band === 'low' || band === 'unknown';
}

/** Renders an icon at a fixed size — used by the status badge. */
export function statusIcon(
  descriptor: StatusDescriptor,
  size = 14,
): ReactNode {
  const Icon = descriptor.icon;
  return <Icon size={size} strokeWidth={2} />;
}
