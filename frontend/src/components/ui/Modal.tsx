import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Button } from './Button';
import { IconClose } from './icons';

/**
 * Accessible modal dialog.
 *
 * Implements the four behaviours a keyboard user expects:
 *  - Escape closes
 *  - focus moves into the dialog on open and returns to the trigger on close
 *  - Tab is trapped inside
 *  - background scroll is locked
 */
export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Prevents closing while a mutation is in flight. */
  busy?: boolean;
}

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
} as const;

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  busy,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;

    previouslyFocused.current = document.activeElement as HTMLElement | null;

    // Lock background scroll without the layout shifting as the scrollbar goes.
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    const previousOverflow = document.body.style.overflow;
    const previousPadding = document.body.style.paddingRight;
    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`;

    // Focus the first control, or the dialog itself if there is none.
    const timer = window.setTimeout(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? dialogRef.current)?.focus();
    }, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPadding;
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose, busy]);

  if (!open) return null;

  const titleId = 'modal-title';
  const descriptionId = description ? 'modal-description' : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto sm:items-center sm:p-4">
      {/* Backdrop: click to close, but not while a request is running. */}
      <div
        className="fixed inset-0 animate-fade-in bg-canvas-inverse/40"
        onClick={() => {
          if (!busy) onClose();
        }}
        aria-hidden="true"
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className={cn(
          'relative z-10 w-full animate-fade-in rounded-t-lg border border-line bg-surface shadow-dialog sm:rounded-lg',
          SIZES[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-md font-semibold text-ink">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-0.5 text-sm text-ink-muted">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close dialog"
            className="-mr-1 -mt-1 rounded p-1 text-ink-faint transition-colors hover:bg-surface-sunken hover:text-ink disabled:opacity-50"
          >
            <IconClose size={16} />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-4 py-4 scrollbar-thin">{children}</div>

        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-app-raised px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Confirmation dialog                                                         */
/* -------------------------------------------------------------------------- */

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Deliberately separate from `Modal`: a destructive action should never be one
 * stray Enter keypress away from a click on a nearby button. The confirm button
 * is not autofocused, so pressing Enter immediately cancels.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'primary',
  busy,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      busy={busy}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            onClick={onConfirm}
            disabled={busy}
            loading={busy}
            variant={tone === 'danger' ? 'danger' : 'primary'}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-ink-muted">{message}</div>
    </Modal>
  );
}