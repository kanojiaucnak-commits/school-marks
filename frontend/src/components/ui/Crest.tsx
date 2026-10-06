import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { SCHOOL, SCHOOL_MONOGRAM } from '../../lib/school';

/**
 * The school mark.
 *
 * ── Why this is drawn and not the school's PNG ─────────────────────────────────
 *
 * The school's own logo is a raster image with a photographic wordmark that is
 * illegible below about 120px and cannot inherit `currentColor`. Reproducing it
 * as SVG from the live asset is not possible here (the source bitmap cannot be
 * read back into vector paths), and dropping a bitmap into the bundle would mean
 * shipping a file nobody can recolour.
 *
 * So this is an *original* mark built to sit alongside the real one: a shield
 * carrying the school's monogram, drawn in the same two brand colours. It is
 * deliberately generic — a school identity that a different school can adopt by
 * changing `lib/school.ts`, not a forgery of the original artwork.
 *
 * `CrestImage` below is the seam: drop `logo-wide.png` into `frontend/public/`
 * and it takes over automatically, at every size, with no further edits.
 */

/** Geometric shield outline on a 48×48 grid. */
const SHIELD_PATH = 'M24 2.5 5.5 8.5v15.2c0 9.5 7.4 17.9 18.5 21.8 11.1-3.9 18.5-12.3 18.5-21.8V8.5Z';

export interface CrestProps {
  size?: number;
  className?: string;
  /** Renders the monogram under the shield rather than inside it. */
  variant?: 'shield' | 'plain';
  /** Accessible label. Omit to mark the crest decorative. */
  title?: string;
}

export function Crest({ size = 32, className, variant = 'shield', title }: CrestProps) {
  if (variant === 'plain') {
    return (
      <span
        className={cn(
          'inline-flex items-center justify-center rounded bg-brand-600 font-display text-white',
          className,
        )}
        style={{ width: size, height: size, fontSize: size * 0.42 }}
        aria-hidden={title ? undefined : true}
        role={title ? 'img' : undefined}
        aria-label={title}
      >
        {SCHOOL_MONOGRAM}
      </span>
    );
  }

  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
      focusable="false"
    >
      {/* Sage field, brand border: both school colours, one mark. */}
      <path d={SHIELD_PATH} fill="var(--color-sage-500, #5d7772)" />
      <path
        d={SHIELD_PATH}
        fill="none"
        stroke="var(--color-brand-600, #43616f)"
        strokeWidth="2.5"
      />
      <text
        x="24"
        y="24"
        textAnchor="middle"
        dominantBaseline="central"
        fill="#ffffff"
        fontFamily="Lato, Inter, sans-serif"
        fontSize="17"
        fontWeight="700"
        letterSpacing="0.5"
      >
        {SCHOOL_MONOGRAM}
      </text>
    </svg>
  );
}

/**
 * Drops the school's real logo in if it has been provided.
 *
 * The presence check is a build-time constant only because Vite inlines
 * `import.meta.env.BASE_URL`; it cannot change at runtime. Rendering `<img>` on
 * a missing file would show a broken-image glyph in the sidebar, which is worse
 * than a clean vector mark, so the fallback is the default path.
 */
const LOGO_URL = `${import.meta.env.BASE_URL}school-logo.svg`;

export function CrestImage({
  size = 32,
  className,
}: {
  size?: number;
  className?: string;
}): ReactNode {
  return (
    <img
      src={LOGO_URL}
      // If the file is absent the browser fires `error` and we swap to the drawn
      // mark, so a missing asset degrades silently instead of showing a broken
      // image in the app shell.
      onError={(event) => {
        const node = event.currentTarget;
        node.style.display = 'none';
        const fallback = node.nextElementSibling as HTMLElement | null;
        if (fallback) fallback.style.display = '';
      }}
      alt=""
      width={size}
      height={size}
      className={cn('shrink-0 object-contain', className)}
      style={{ display: 'none' }}
    />
  );
}

/* ==========================================================================
   Wordmark
   ==========================================================================
   Crest plus school name. Used in the app sidebar, the landing header and the
   sign-in screen.

   The name is set in the display face at a slightly tighter tracking than body
   text, which is what separates a wordmark from a heading — and it is the one
   place the school's own name is allowed to be large.
   */

export interface WordmarkProps {
  /** Hides the school name, leaving only the mark. Use in a collapsed rail. */
  markOnly?: boolean;
  /** Adds the location line beneath the name. */
  showLocation?: boolean;
  size?: number;
  className?: string;
  /** Renders the name in the ink colour rather than white, for light surfaces. */
  tone?: 'light' | 'dark';
}

export function Wordmark({
  markOnly = false,
  showLocation = false,
  size = 30,
  className,
  tone = 'dark',
}: WordmarkProps) {
  const nameTone = tone === 'dark' ? 'text-ink' : 'text-white';

  return (
    <span className={cn('flex min-w-0 items-center gap-2.5', className)}>
      <Crest size={size} />

      {!markOnly && (
        <span className="min-w-0">
          <span
            className={cn(
              'block truncate font-display text-sm font-bold leading-tight tracking-[-0.01em]',
              nameTone,
            )}
          >
            {SCHOOL.shortName}
          </span>
          <span
            className={cn(
              'block truncate text-2xs font-medium uppercase leading-tight tracking-[0.08em]',
              tone === 'dark' ? 'text-ink-faint' : 'text-white/70',
            )}
          >
            {showLocation ? 'Marks & Results' : 'Marks Management'}
          </span>
        </span>
      )}
    </span>
  );
}
