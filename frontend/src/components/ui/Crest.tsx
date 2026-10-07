import { cn } from '../../lib/utils';
import { SCHOOL } from '../../lib/school';

/**
 * The school seal.
 *
 * A roundel, not a shield. A previous drawn crest existed and was removed in
 * favor of setting the brand in type alone; what this adds is the one thing
 * type cannot carry — a small identity mark for the three places where the
 * school's name is already spoken on the same line (the landing masthead, the
 * landing footer, the sign-in header). The mark can therefore stay quiet and
 * purely graphic, and the type keeps doing the reading.
 *
 * Construction, in a 48-unit box:
 *
 *  - a 2.5-unit brand ring on the soft brand field — the seal's edge;
 *  - a hairline inner ring, which is what makes a circle read as a *seal*
 *    rather than a badge or an avatar;
 *  - the school's initials derived from `shortName` (two words → "CC") in the
 *    display face, so renaming the school in `lib/school.ts` re-derives the
 *    monogram instead of leaving a stale one behind;
 *  - the short brand rule from `.rule-brand`, shrunk — the same device the
 *    landing headings use, tying the mark to the rest of the identity.
 *
 * Deliberately no gradients, no lettering around the ring (illegible below
 * ~60px), and no unique element ids — it renders several times per page, and
 * duplicated ids in SVG defs are a classic silent failure.
 */

/** Two initials from the short name: "Christ Church Co-Ed" → "CC". */
function monogramOf(shortName: string): string {
  const initials = shortName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
  return initials || '•';
}

const TONES = {
  /** On light surfaces: the full brand. */
  brand: {
    field: '#f2f6f7', // brand-50
    ring: '#43616f', // brand-600
    inner: '#c8dade', // brand-200
    text: '#2a3f48', // brand-800
    rule: '#5d7772', // sage-500
  },
  /** On the brand fields (footer, sidebar-style mastheads): reversed out. */
  light: {
    field: 'rgba(255, 255, 255, 0.10)',
    ring: 'rgba(255, 255, 255, 0.85)',
    inner: 'rgba(255, 255, 255, 0.35)',
    text: '#ffffff',
    rule: '#a5bbb5', // sage-300 — reads on brand-700/800
  },
} as const;

export interface CrestProps {
  /** Rendered size in px; the viewBox is square. */
  size?: number;
  tone?: keyof typeof TONES;
  className?: string;
}

export function Crest({ size = 36, tone = 'brand', className }: CrestProps) {
  const c = TONES[tone];

  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={cn('shrink-0', className)}
      aria-hidden="true"
      focusable="false"
    >
      {/* Seal edge: the outer ring on its soft field. */}
      <circle cx="24" cy="24" r="22" fill={c.field} stroke={c.ring} strokeWidth="2.5" />
      {/* The hairline that turns a badge into a seal. */}
      <circle cx="24" cy="24" r="17.5" fill="none" stroke={c.inner} strokeWidth="1" />
      <text
        x="24"
        y="24.5"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="'Lato', 'Inter', -apple-system, 'Segoe UI', sans-serif"
        fontSize="15"
        fontWeight="900"
        letterSpacing="-0.5"
        fill={c.text}
      >
        {monogramOf(SCHOOL.shortName)}
      </text>
      {/* The brand rule, shrunk — the same device as `.rule-brand`. */}
      <rect x="20" y="32.5" width="8" height="1.75" rx="0.875" fill={c.rule} />
    </svg>
  );
}
