import { useEffect, useRef, useState } from 'react';
import type { BoundingBox } from '@school/shared';
import { cn, formatBytes } from '../../lib/utils';
import { ConfidenceIndicator } from '../ui/Badge';
import { Alert, LoadingState } from '../ui/States';

/**
 * OCR review helpers: the original-document viewer and the confidence indicator.
 *
 * The design intent throughout is that **the scan is the source of truth and the
 * extracted table is a draft of it**. The document sits on the left at full size,
 * the extracted values on the right, and selecting a row highlights where that
 * value came from — so a reviewer compares rather than trusts.
 */

/**
 * Confidence, as a short bar and a word.
 *
 * Deliberately not a percentage badge. A reviewer needs to know "can I accept
 * this or must I check it"; dressing the number up as a metric implies a
 * precision the OCR engine does not have.
 */
export function ConfidenceBadge({
  confidence,
  size = 'xs',
}: {
  confidence: number | null;
  size?: 'xs' | 'sm' | 'md';
}) {
  return <ConfidenceIndicator confidence={confidence} size={size} />;
}

/* -------------------------------------------------------------------------- */
/* Document viewer                                                             */
/* -------------------------------------------------------------------------- */

export interface DocumentViewerProps {
  src: string;
  /** Normalised 0..1 coordinates of the row to highlight. */
  highlightBox: BoundingBox | null;
  contentType: string;
  filename: string;
}

/**
 * Displays the original upload with the selected row's bounding box drawn over
 * it.
 *
 * Images render inline with the box overlaid. PDFs cannot be overlaid with a
 * `<div>` — the browser's built-in viewer owns the rendering — so PDFs fall back
 * to a plain embed with a note explaining how to locate the row. That is an
 * honest limitation rather than a broken-looking highlight.
 */
export function DocumentViewer({
  src,
  highlightBox,
  contentType,
  filename,
}: DocumentViewerProps) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Reset when the document changes.
  useEffect(() => {
    setLoading(true);
    setFailed(false);
    setNaturalSize(null);
  }, [src]);

  const isPdf = contentType === 'application/pdf';

  if (failed) {
    return (
      <div className="p-4">
        <Alert tone="warning" title="Could not display the document">
          The image could not be loaded from storage. You can still review the extracted rows
          alongside — compare them against your own copy.
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex min-h-64 flex-col bg-surface-sunken" ref={containerRef}>
      {isPdf ? (
        <div className="p-4">
          <Alert tone="info" title="PDF preview">
            The extracted values are listed alongside. Compare them against your copy of the
            document as you verify each row.
          </Alert>
          <object
            data={src}
            type="application/pdf"
            className="mt-3 h-[28rem] w-full rounded border border-line"
            aria-label={`Original document: ${filename}`}
            onLoad={() => setLoading(false)}
          >
            {/* Some browsers refuse to render PDFs inline; give a direct link. */}
            <a href={src} target="_blank" rel="noreferrer" className="text-brand-700 underline">
              Open {filename} in a new tab
            </a>
          </object>
        </div>
      ) : (
        <div className="relative flex-1">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center">
              <LoadingState label="Loading document…" />
            </div>
          )}

          <img
            src={src}
            alt={`Original mark sheet: ${filename}`}
            onLoad={(event) => {
              setNaturalSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              });
              setLoading(false);
            }}
            onError={() => setFailed(true)}
            className="select-none"
            // Stop long documents from making the page enormous.
            style={{ maxHeight: 'calc(100vh - 16rem)', objectFit: 'contain', width: '100%' }}
          />

          {highlightBox && naturalSize && !loading && (
            <BoundingBoxOverlay box={highlightBox} containerRef={containerRef} />
          )}
        </div>
      )}

      {/*
        Stating the privacy model on the screen that shows the scan: an
        uploader should be able to see that a mark sheet is not sitting on a
        public bucket.
      */}
      <p className="mt-auto border-t border-line bg-surface px-4 py-2 text-xs text-ink-subtle">
        Stored privately. This file is served through an authorised endpoint only — it has no public
        URL.
      </p>
    </div>
  );
}

/**
 * The highlighted region.
 *
 * A ring plus a dimming scrim over everything outside it. The scrim is the
 * effective signal: it makes the eye land on one row of a page of numbers without
 * the highlight needing to be loud.
 */
function BoundingBoxOverlay({
  box,
  containerRef,
}: {
  box: BoundingBox;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const image = container?.querySelector('img');
    if (!container || !image) return undefined;

    const measure = () => {
      const rect = image.getBoundingClientRect();
      const parent = container.getBoundingClientRect();
      // Coordinates are normalised, so they scale with the rendered image.
      setPosition({
        left: rect.left - parent.left + rect.width * box.x,
        top: rect.top - parent.top + rect.height * box.y,
        width: rect.width * box.width,
        height: rect.height * box.height,
      });
    };

    measure();
    window.addEventListener('resize', measure);
    // Re-measure once the image finishes decoding at its final size.
    image.addEventListener('load', measure);
    return () => {
      window.removeEventListener('resize', measure);
      image.removeEventListener('load', measure);
    };
  }, [box, containerRef]);

  if (!position) return null;

  return (
    <div
      className={cn(
        'pointer-events-none absolute z-10 animate-fade-in rounded-xs ring-2 ring-brand-600',
      )}
      style={{
        left: position.left,
        top: position.top,
        width: Math.max(position.width, 12),
        height: Math.max(position.height, 12),
        // Dims everything outside the highlighted row.
        boxShadow: '0 0 0 9999px rgb(15 23 42 / 0.55)',
      }}
      aria-hidden="true"
    />
  );
}

export { formatBytes };
