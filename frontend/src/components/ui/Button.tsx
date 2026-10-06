import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/utils';

/**
 * Buttons.
 *
 * Three weights, not six:
 *
 *  - **primary** — one per screen. If a user can only do one thing here, this is
 *    it. Two primaries on a page means neither one is primary.
 *  - **secondary** — the default. An outlined button that sits quietly next to
 *    content.
 *  - **ghost** — for icon buttons and low-emphasis actions inside a toolbar.
 *
 * `danger` is separate and deliberately not reachable by accident: destructive
 * actions always sit behind a `ConfirmDialog`, and the button never shares a
 * shape with a safe one.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  // The school's own slate-teal, white text, no gradient and no ring — an outline
  // plus fill fights itself and looks dated. The hover steps *darker* rather than
  // toward the brand hue, which keeps a dense grid of buttons from shimmering
  // when the pointer passes over it.
  primary:
    'bg-brand-600 text-white shadow-xs hover:bg-brand-700 active:bg-brand-800 disabled:bg-brand-300',
  secondary:
    'border border-line bg-surface text-ink shadow-xs hover:bg-surface-muted active:bg-surface-sunken disabled:text-ink-faint',
  ghost: 'text-ink-muted hover:bg-surface-sunken hover:text-ink active:bg-surface-sunken disabled:text-ink-faint',
  danger:
    'bg-danger-strong text-white shadow-xs hover:bg-danger-700 active:bg-danger-800 disabled:bg-danger-300',
  subtle: 'bg-brand-50 text-brand-700 hover:bg-brand-100 active:bg-brand-200 disabled:text-brand-300',
};

const SIZES: Record<ButtonSize, string> = {
  xs: 'h-control-xs gap-1 px-2 text-xs',
  sm: 'h-control-sm gap-1.5 px-2.5 text-sm',
  md: 'h-control gap-2 px-3.5 text-sm',
  // Only for the sign-in and password screens, where the form is the whole page.
  lg: 'h-control-md gap-2 px-4 text-sm',
};

const BASE =
  'inline-flex select-none items-center justify-center whitespace-nowrap rounded font-medium transition-colors duration-100 disabled:cursor-not-allowed';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Rendered before the label. */
  icon?: ReactNode;
  /** Rendered after the label. */
  trailing?: ReactNode;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading,
    icon,
    trailing,
    fullWidth,
    className,
    children,
    disabled,
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && 'w-full', className)}
      {...props}
    >
      {loading ? (
        <span
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : (
        icon && (
          <span aria-hidden="true" className="shrink-0">
            {icon}
          </span>
        )
      )}
      {children}
      {trailing && !loading && (
        <span aria-hidden="true" className="shrink-0">
          {trailing}
        </span>
      )}
    </button>
  );
});

export interface LinkButtonProps {
  to: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
  icon?: ReactNode;
  title?: string;
  'aria-label'?: string;
  onClick?: () => void;
}

export function LinkButton({
  to,
  variant = 'secondary',
  size = 'md',
  className,
  children,
  icon,
  title,
  ...rest
}: LinkButtonProps) {
  return (
    <Link to={to} title={title} className={cn(BASE, VARIANTS[variant], SIZES[size], className)} {...rest}>
      {icon && (
        <span aria-hidden="true" className="shrink-0">
          {icon}
        </span>
      )}
      {children}
    </Link>
  );
}

/**
 * Icon-only button.
 *
 * `label` is required and becomes the accessible name — an icon button with no
 * label is unusable with a screen reader and unidentifiable on hover.
 */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonProps, 'children' | 'icon'> & { label: string; icon: ReactNode; size?: ButtonSize }
>(function IconButton({ label, icon, size = 'sm', className, type = 'button', ...props }, ref) {
  const box = { xs: 'h-6 w-6', sm: 'h-control-sm w-control-sm', md: 'h-control w-control', lg: 'h-control-md w-control-md' }[size];

  return (
    <button
      ref={ref}
      type={type}
      title={label}
      aria-label={label}
      className={cn(BASE, VARIANTS.ghost, box, 'shrink-0', className)}
      {...props}
    >
      <span aria-hidden="true">{icon}</span>
    </button>
  );
});
