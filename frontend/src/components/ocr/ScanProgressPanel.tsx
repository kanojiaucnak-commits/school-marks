import { cn } from '../../lib/utils';
import type { ScanProgress } from '../../lib/ocr/pipeline';

/**
 * What the browser is doing with a mark sheet right now.
 *
 * Shared by the upload screen and the retry path on the review screen, which run
 * the identical pipeline and would otherwise drift into reporting the same work
 * differently.
 *
 * Deliberately verbose. Recognition happens in a worker thread with no DOM to
 * update, so this is the only signal a teacher has, and the phases fail very
 * differently: the engine download fails on the school's wifi, a page read fails
 * on a blurry photograph, and matching fails on a roster mismatch. "Reading"
 * alone would collapse three distinct problems into one.
 *
 * The bar is indeterminate whenever the fraction is unknown. A progress bar
 * sitting at 0% while ~10 MB of OCR engine downloads reads as a hang, and on a
 * phone that download is most of the first scan of the session.
 */
export function ScanProgressPanel({
  progress,
  className,
}: {
  progress: ScanProgress;
  className?: string;
}) {
  const label =
    progress.phase === 'uploading'
      ? 'Uploading the file'
      : progress.phase === 'matching'
        ? 'Matching rows to the class roll'
        : progress.stage === 'loading'
          ? 'Starting the reader'
          : 'Reading the sheet';

  // Only claim to be reading a specific page once there is more than one, and
  // only claim progress within a page when a fraction was actually reported.
  const showsPageCount = (progress.page?.total ?? 0) > 1;

  return (
    <div
      className={cn('rounded-xl border border-line bg-surface-muted p-4', className)}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-brand-500" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">{label}</p>
          <p className="mt-0.5 text-xs text-ink-muted">{progress.message}</p>

          {showsPageCount && (
            <p className="tabular mt-1 text-xs text-ink-subtle">
              Page {progress.page?.current} of {progress.page?.total}
            </p>
          )}

          {progress.fraction !== null ? (
            <div
              className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress.fraction * 100)}
              aria-label={label}
            >
              <div
                className="h-full rounded-full bg-brand-500 transition-[width] duration-300"
                style={{ width: `${Math.round(progress.fraction * 100)}%` }}
              />
            </div>
          ) : (
            // Deliberately not a progress bar: there is no denominator, and
            // pretending otherwise with a bar frozen at 0% is worse than an
            // obvious "busy, no number available" treatment.
            <div className="mt-2.5 flex gap-1" aria-hidden="true">
              {[0, 1, 2].map((index) => (
                <span
                  key={index}
                  className="h-1.5 w-8 animate-pulse rounded-full bg-brand-300"
                  style={{ animationDelay: `${index * 150}ms` }}
                />
              ))}
            </div>
          )}

          {progress.phase === 'reading' && progress.stage === 'loading' && (
            <p className="mt-2 text-xs text-ink-subtle">
              The first scan of the session downloads the OCR engine. Later ones reuse it and are
              much faster.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}