import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '../../lib/utils';
import { IconAlertCircle, IconChevronDown, IconSearch } from './icons';

/**
 * Form controls.
 *
 * Design constraints:
 *
 *  - **One control height scale.** `h-control` everywhere, so a toolbar mixing a
 *    search box, a select and a button lines up without per-component fiddling.
 *  - **Errors are next to the field and never colour alone.** Each invalid
 *    control gets a border colour, an `aria-invalid`, and a message with an
 *    icon — so the failure survives a colour-blind user, a high-contrast mode
 *    and a screenshot.
 *  - **Placeholder is never the label.** Placeholders disappear the moment
 *    someone types, which makes a form unreviewable.
 */

export const CONTROL_HEIGHT = {
  sm: 'h-control-sm',
  DEFAULT: 'h-control',
  md: 'h-control-md',
} as const;

/* ==========================================================================
   Field wrapper
   ========================================================================== */

export interface FieldProps {
  label: string;
  htmlFor: string;
  error?: string | null;
  hint?: string;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

export function Field({ label, htmlFor, error, hint, required, className, children }: FieldProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
        {label}
        {required && (
          <>
            <span aria-hidden="true" className="ml-0.5 text-danger-strong">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        )}
      </label>

      {children}

      {hint && !error && (
        <p id={`${htmlFor}-hint`} className="text-xs text-ink-subtle">
          {hint}
        </p>
      )}

      {error && (
        <p
          id={`${htmlFor}-error`}
          role="alert"
          className="flex items-start gap-1.5 text-xs font-medium text-danger-strong"
        >
          <IconAlertCircle size={13} className="mt-px shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

const CONTROL_BASE =
  'block w-full rounded border bg-surface text-sm text-ink shadow-xs transition-colors placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-offset-0 disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-subtle';
const CONTROL_OK = 'border-line focus:border-brand-500 focus:ring-brand-200';
const CONTROL_ERR = 'border-danger-400 focus:border-danger-500 focus:ring-danger-200';

/* ==========================================================================
   Text input
   ========================================================================== */

export interface TextInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'size'> {
  label: string;
  id?: string;
  error?: string | null;
  hint?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  containerClassName?: string;
  controlSize?: keyof typeof CONTROL_HEIGHT;
  /** Hides the label visually but keeps it for assistive technology. */
  hideLabel?: boolean;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  {
    label,
    id,
    error,
    hint,
    leading,
    trailing,
    className,
    containerClassName,
    required,
    controlSize = 'DEFAULT',
    hideLabel,
    ...props
  },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <Field
      label={label}
      htmlFor={inputId}
      error={error}
      hint={hint}
      required={required}
      className={containerClassName}
    >
      <div className="relative">
        {leading && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
          >
            {leading}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          className={cn(
            CONTROL_BASE,
            CONTROL_HEIGHT[controlSize],
            error ? CONTROL_ERR : CONTROL_OK,
            'px-3',
            leading && 'pl-9',
            trailing && 'pr-10',
            className,
          )}
          {...props}
        />
        {trailing && <span className="absolute right-2 top-1/2 -translate-y-1/2">{trailing}</span>}
      </div>
      {hideLabel && <span className="sr-only">{label}</span>}
    </Field>
  );
});

/* ==========================================================================
   Select
   ========================================================================== */

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Groups options under an `<optgroup>`. */
  group?: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id' | 'size'> {
  label: string;
  id?: string;
  error?: string | null;
  hint?: string;
  options: SelectOption[];
  placeholder?: string;
  containerClassName?: string;
  /** Constrains the width of the control itself, for dense toolbars. */
  wrapperClassName?: string;
  controlSize?: keyof typeof CONTROL_HEIGHT;
  hideLabel?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    label,
    id,
    error,
    hint,
    options,
    placeholder,
    className,
    containerClassName,
    wrapperClassName,
    required,
    controlSize = 'DEFAULT',
    hideLabel,
    ...props
  },
  ref,
) {
  const generatedId = useId();
  const selectId = id ?? generatedId;

  // Options arrive flat with an optional group key; render real optgroups so a
  // long list (subjects per class) stays navigable.
  const groups = options.reduce<Map<string, SelectOption[]>>((accumulator, option) => {
    const key = option.group ?? '';
    const list = accumulator.get(key) ?? [];
    list.push(option);
    accumulator.set(key, list);
    return accumulator;
  }, new Map());

  return (
    <div className={cn(wrapperClassName)}>
      <Field
        label={label}
        htmlFor={selectId}
        error={error}
        hint={hint}
        required={required}
        className={containerClassName}
      >
        <div className="relative">
        <select
          ref={ref}
          id={selectId}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined}
          className={cn(
            CONTROL_BASE,
            CONTROL_HEIGHT[controlSize],
            'cursor-pointer appearance-none pr-8',
            error ? CONTROL_ERR : CONTROL_OK,
            className,
          )}
          {...props}
        >
          {placeholder && (
            <option value="" disabled={required}>
              {placeholder}
            </option>
          )}
          {[...groups.entries()].map(([group, groupOptions]) =>
            group ? (
              <optgroup key={group} label={group}>
                {groupOptions.map((option) => (
                  <option key={option.value} value={option.value} disabled={option.disabled}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            ) : (
              groupOptions.map((option) => (
                <option key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </option>
              ))
            ),
          )}
        </select>
        <IconChevronDown
          size={14}
          aria-hidden="true"
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-faint"
        />
        </div>
      </Field>
      {hideLabel && <span className="sr-only">{label}</span>}
    </div>
  );
});

/* ==========================================================================
   Textarea
   ========================================================================== */

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label: string;
  id?: string;
  error?: string | null;
  hint?: string;
  containerClassName?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, id, error, hint, className, containerClassName, required, rows = 3, ...props },
  ref,
) {
  const generatedId = useId();
  const textareaId = id ?? generatedId;

  return (
    <Field
      label={label}
      htmlFor={textareaId}
      error={error}
      hint={hint}
      required={required}
      className={containerClassName}
    >
      <textarea
        ref={ref}
        id={textareaId}
        rows={rows}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${textareaId}-error` : hint ? `${textareaId}-hint` : undefined}
        className={cn(CONTROL_BASE, error ? CONTROL_ERR : CONTROL_OK, 'px-3 py-2', className)}
        {...props}
      />
    </Field>
  );
});

/* ==========================================================================
   Search
   ========================================================================== */

export interface SearchInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type' | 'size'> {
  id?: string;
  label?: string;
  controlSize?: keyof typeof CONTROL_HEIGHT;
  wrapperClassName?: string;
  onClear?: () => void;
}

/**
 * Search box with a leading glyph and a clear affordance.
 *
 * Uses `type="search"` so browsers offer their own clear button and screen
 * readers announce the correct role.
 */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { id, label = 'Search', controlSize = 'sm', className, wrapperClassName, onClear, value, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <div className={cn('relative', wrapperClassName)}>
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <IconSearch
        size={14}
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint"
      />
      <input
        ref={ref}
        id={inputId}
        type="search"
        value={value}
        className={cn(
          CONTROL_BASE,
          CONTROL_HEIGHT[controlSize],
          'border-line pl-8',
          onClear && String(value ?? '').length > 0 ? 'pr-8' : 'pr-3',
          className,
        )}
        {...props}
      />
      {onClear && String(value ?? '').length > 0 && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-ink-faint transition-colors hover:bg-surface-sunken hover:text-ink"
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      )}
    </div>
  );
});

/* ==========================================================================
   Checkbox and radio
   ========================================================================== */

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'> {
  label: string;
  id?: string;
  description?: string;
  containerClassName?: string;
}

export function Checkbox({
  label,
  id,
  description,
  className,
  containerClassName,
  ...props
}: CheckboxProps) {
  const generatedId = useId();
  const checkboxId = id ?? generatedId;

  return (
    <div className={cn('flex items-start gap-2.5', containerClassName)}>
      <input
        id={checkboxId}
        type="checkbox"
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded-xs border-line-strong text-brand-600',
          'focus:ring-2 focus:ring-brand-200 focus:ring-offset-0',
          className,
        )}
        {...props}
      />
      <div className="min-w-0">
        <label htmlFor={checkboxId} className="cursor-pointer text-sm text-ink">
          {label}
        </label>
        {description && <p className="mt-0.5 text-xs text-ink-subtle">{description}</p>}
      </div>
    </div>
  );
}

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type'> {
  label: string;
  id?: string;
  description?: string;
  containerClassName?: string;
}

export function Radio({ label, id, description, className, containerClassName, ...props }: RadioProps) {
  const generatedId = useId();
  const radioId = id ?? generatedId;

  return (
    <div className={cn('flex items-start gap-2.5', containerClassName)}>
      <input
        id={radioId}
        type="radio"
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0 cursor-pointer border-line-strong text-brand-600',
          'focus:ring-2 focus:ring-brand-200 focus:ring-offset-0',
          className,
        )}
        {...props}
      />
      <div className="min-w-0">
        <label htmlFor={radioId} className="cursor-pointer text-sm text-ink">
          {label}
        </label>
        {description && <p className="mt-0.5 text-xs text-ink-subtle">{description}</p>}
      </div>
    </div>
  );
}

/* ==========================================================================
   Segmented control
   ========================================================================== */

/**
 * A small set of mutually exclusive options rendered as one control.
 *
 * Used where a `<select>` would hide the choices behind a click — "today / week /
 * month" on a report, "all / low confidence only" on OCR. Keeps every option
 * visible, which suits a known, short list.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; count?: number }>;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('inline-flex rounded border border-line bg-surface p-0.5', className)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-sm px-2.5 py-1 text-xs font-medium transition-colors',
              selected ? 'bg-brand-600 text-white' : 'text-ink-muted hover:bg-surface-muted hover:text-ink',
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span className={cn('tabular ml-1.5', selected ? 'text-white/80' : 'text-ink-faint')}>
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
