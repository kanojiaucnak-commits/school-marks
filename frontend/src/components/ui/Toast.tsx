import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';
import { IconAlertCircle, IconCheck, IconInfo, IconX } from './icons';

/**
 * Toast notifications.
 *
 * Rendered into a portal so they escape any `overflow: hidden` ancestor.
 *
 * Duration policy, which is the part that matters: errors stay until dismissed,
 * because a message that vanishes before it is read is worse than no message at
 * all. Successes dismiss themselves; warnings linger a little longer than a
 * success because they usually need a decision.
 */

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  /** Milliseconds; `null` keeps it until dismissed. */
  duration: number | null;
  action?: { label: string; onClick: () => void };
}

interface ToastContextValue {
  toast: (input: Omit<Toast, 'id' | 'duration'> & { duration?: number | null }) => string;
  success: (title: string, description?: string) => string;
  error: (title: string, description?: string) => string;
  dismiss: (id: string) => void;
  toasts: Toast[];
}

const ToastContext = createContext<ToastContextValue | null>(null);

let counter = 0;
const nextId = () => `toast-${++counter}`;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, number>());

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback<ToastContextValue['toast']>(
    ({ tone, title, description, duration, action }) => {
      const id = nextId();
      const resolvedDuration = duration ?? (tone === 'error' ? null : tone === 'warning' ? 8000 : 4500);

      const entry: Toast = { id, tone, title, description, duration: resolvedDuration, action };
      // Cap the stack at five; an older notification nobody read is not worth
      // displacing a newer one.
      setToasts((current) => [...current.slice(-4), entry]);

      if (resolvedDuration !== null) {
        const timer = window.setTimeout(() => dismiss(id), resolvedDuration);
        timers.current.set(id, timer);
      }
      return id;
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      dismiss,
      toasts,
      success: (title, description) => toast({ tone: 'success', title, description }),
      error: (title, description) => toast({ tone: 'error', title, description }),
    }),
    [toast, dismiss, toasts],
  );

  // Clear pending timers if the provider unmounts.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}

/* ==========================================================================
   Viewport
   ========================================================================== */

const TONE_STYLES: Record<ToastTone, { container: string; icon: ReactNode; iconColour: string }> = {
  success: {
    container: 'border-success-300',
    icon: <IconCheck size={16} />,
    iconColour: 'text-success-strong',
  },
  error: {
    container: 'border-danger-300',
    icon: <IconX size={16} />,
    iconColour: 'text-danger-strong',
  },
  warning: {
    container: 'border-warning-300',
    icon: <IconAlertCircle size={16} />,
    iconColour: 'text-warning-strong',
  },
  info: { container: 'border-line', icon: <IconInfo size={16} />, iconColour: 'text-ink-subtle' },
};

/**
 * Toasts stack bottom-centre on mobile and top-right on desktop.
 *
 * Errors use `aria-live="assertive"` so they interrupt; everything else is
 * polite and waits its turn. A confirmation that interrupts a screen reader is
 * its own kind of noise.
 */
function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:top-0 sm:items-end"
      aria-label="Notifications"
    >
      {toasts.map((item) => {
        const style = TONE_STYLES[item.tone];
        return (
          <div
            key={item.id}
            role={item.tone === 'error' ? 'alert' : 'status'}
            aria-live={item.tone === 'error' ? 'assertive' : 'polite'}
            className={cn(
              'pointer-events-auto flex w-full max-w-sm animate-slide-in-right items-start gap-2.5 rounded-lg border bg-surface p-3 shadow-popover',
              style.container,
            )}
          >
            <span aria-hidden="true" className={cn('mt-px shrink-0', style.iconColour)}>
              {style.icon}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">{item.title}</p>
              {item.description && (
                <p className="mt-0.5 break-words text-xs text-ink-muted">{item.description}</p>
              )}
              {item.action && (
                <button
                  type="button"
                  onClick={() => {
                    item.action?.onClick();
                    onDismiss(item.id);
                  }}
                  className="mt-1.5 text-xs font-medium text-brand-700 hover:underline"
                >
                  {item.action.label}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(item.id)}
              aria-label="Dismiss notification"
              className="-mr-1 -mt-1 shrink-0 rounded p-1 text-ink-faint transition-colors hover:bg-surface-sunken hover:text-ink"
            >
              <IconX size={14} />
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
