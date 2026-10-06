import { cn } from '../../lib/utils';
import { SCHOOL } from '../../lib/school';

/**
 * The wordmark: the school name with its descriptor line.
 *
 * There is deliberately no logo mark. The previous `Crest` — a drawn shield
 * carrying the monogram — and the `CrestImage` seam (an opt-in `logo-wide.png`
 * in `frontend/public/`) have been removed; the brand is now set in type alone.
 * Renaming the school in `lib/school.ts` (or `VITE_SCHOOL_*`) changes this
 * everywhere it appears: the app sidebar, the landing header and the sign-in
 * screen.
 */

export interface WordmarkProps {
  className?: string;
  /** Renders the name in the ink colour rather than white, for light surfaces. */
  tone?: 'light' | 'dark';
}

export function Wordmark({ className, tone = 'dark' }: WordmarkProps) {
  const nameTone = tone === 'dark' ? 'text-ink' : 'text-white';

  return (
    <span className={cn('flex min-w-0 items-center', className)}>
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
          Marks Management
        </span>
      </span>
    </span>
  );
}