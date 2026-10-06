import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { validateMark, type MarkStatus } from '@school/shared';
import { cn, formatMark } from '../../lib/utils';
import { IconAlertCircle, IconLock } from '../ui/icons';

/**
 * A single marks cell.
 *
 * This is the component a teacher spends an entire day inside, so it is built
 * for speed and for never being wrong.
 *
 * **Keyboard behaviour** — entering a class must never require the mouse:
 *   - Enter / ArrowDown → next row, and commit
 *   - Shift+Enter / ArrowUp → previous row, and commit
 *   - Tab / Shift+Tab → next / previous field (browser default, plus commit)
 *   - ArrowLeft / ArrowRight at the text edge → move between rows
 *
 * **Value handling** — the draft is kept as a string so a half-typed "8" on the
 * way to "87" is never clobbered by a re-render, and a value coming back from
 * the server is ignored while the field has focus.
 *
 * **Cell states** — every state is distinguishable without a tooltip, and none of
 * them rely on colour alone:
 *
 *   | State    | Appearance                       | Extra signal            |
 *   |----------|----------------------------------|-------------------------|
 *   | Empty    | plain                            | placeholder             |
 *   | Edited   | amber left rail + tinted field    | `aria-describedby` note |
 *   | Invalid  | red border, red message below     | `aria-invalid`          |
 *   | Locked   | muted, not editable               | lock glyph in the cell  |
 *   | Non-numeric | disabled, no value shown       | status badge in the row |
 */

export interface MarkCellProps {
  value: number | null;
  maxMarks: number;
  status: MarkStatus;
  disabled: boolean;
  /** Called on every committed change; receives the raw string. */
  onCommit: (raw: string, status: MarkStatus) => void;
  /** Called when the user asks to move to another row. */
  onNavigate: (direction: 1 | -1, focus: boolean) => void;
  registerRef?: (element: HTMLInputElement | null) => void;
  rowIndex: number;
  columnIndex: number;
  /** True when this cell's value differs from the last saved value. */
  edited?: boolean;
}

export function MarkCell({
  value,
  maxMarks,
  status,
  disabled,
  onCommit,
  onNavigate,
  registerRef,
  rowIndex,
  columnIndex,
  edited = false,
}: MarkCellProps) {
  const [draft, setDraft] = useState<string>(value === null ? '' : String(value));
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Adopt server values only while the user is not mid-edit. Without the
  // `touched` guard a background refresh would overwrite what someone is typing.
  useEffect(() => {
    if (touched) return;
    setDraft(value === null ? '' : String(value));
  }, [value, touched]);

  const effectiveStatus: MarkStatus = status ?? 'PRESENT';
  const isNonNumeric = effectiveStatus !== 'PRESENT';

  const validation = useMemo(
    () => validateMark(draft, maxMarks, effectiveStatus),
    [draft, maxMarks, effectiveStatus],
  );

  const showError = touched && !validation.valid;
  const isEmpty = draft.trim() === '';

  const commit = useCallback(() => {
    setTouched(false);
    // A non-numeric status carries no number; never send one, or the row would
    // be recorded as "present with a mark of zero".
    onCommit(isNonNumeric ? '' : draft.trim(), effectiveStatus);
  }, [draft, isNonNumeric, effectiveStatus, onCommit]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const { key, shiftKey } = event;

    if (key === 'Enter') {
      event.preventDefault();
      commit();
      onNavigate(shiftKey ? -1 : 1, true);
      return;
    }

    if (key === 'ArrowDown' || (key === 'Tab' && !shiftKey)) {
      commit();
      onNavigate(1, true);
      if (key === 'ArrowDown') event.preventDefault();
      return;
    }

    if (key === 'ArrowUp') {
      event.preventDefault();
      commit();
      onNavigate(-1, true);
      return;
    }

    // Left/right only move rows at the text boundary, so they still work as
    // ordinary caret movement everywhere else.
    if (key === 'ArrowLeft' && event.currentTarget.selectionStart === 0) {
      commit();
      onNavigate(-1, true);
      event.preventDefault();
      return;
    }

    if (key === 'ArrowRight') {
      const input = event.currentTarget;
      const atEnd =
        input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
      if (atEnd) {
        commit();
        onNavigate(1, true);
        event.preventDefault();
      }
    }
  };

  const label = `Mark for row ${rowIndex + 1}, column ${columnIndex + 1}`;
  const errorId = `mark-error-${rowIndex}-${columnIndex}`;
  const noteId = `mark-note-${rowIndex}-${columnIndex}`;

  return (
    <div className="relative">
      {/*
        A left rail marks an edited-but-unsaved value. It is a second channel
        alongside the tint, so the state survives a monochrome display.
      */}
      {edited && !showError && !disabled && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-1 left-0 w-0.5 rounded-full bg-warning-500"
        />
      )}

      <input
        ref={(element) => {
          inputRef.current = element;
          registerRef?.(element);
        }}
        type="text"
        inputMode="decimal"
        // `decimal` rather than `numeric` so Android shows a full keypad.
        enterKeyHint="next"
        autoComplete="off"
        disabled={disabled || isNonNumeric}
        value={draft}
        aria-label={label}
        aria-invalid={showError || undefined}
        aria-errormessage={showError ? errorId : undefined}
        aria-describedby={showError ? errorId : edited && !disabled ? noteId : undefined}
        data-mark-row={rowIndex}
        onChange={(event) => {
          // Block anything that cannot be part of a number. The server
          // re-validates regardless — this is about not typing nonsense, not
          // about being the only line of defence.
          const next = event.target.value.replace(/[^0-9.]/g, '');
          setDraft(next);
          setTouched(true);
        }}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={handleKeyDown}
        onBlur={commit}
        placeholder={disabled || isNonNumeric ? '' : '—'}
        className={cn(
          'tabular h-9 w-full rounded border px-2 text-right text-sm shadow-xs transition-colors duration-100',
          'focus:outline-none focus:ring-2 focus:ring-offset-0',
          // Locked and non-numeric: muted, clearly not a place to type.
          disabled || isNonNumeric
            ? 'cursor-not-allowed border-transparent bg-surface-sunken pl-2.5 text-ink-subtle'
            : showError
              ? 'border-danger-400 bg-danger-soft text-danger-strong focus:border-danger-500 focus:ring-danger-200'
              : edited
                ? 'border-warning-300 bg-warning-soft/60 focus:border-warning-500 focus:ring-warning-200'
                : 'border-transparent bg-surface hover:border-line-strong focus:border-brand-500 focus:ring-brand-200',
          // The focused cell gets a doubled ring so it is unmissable when
          // tabbing through forty rows.
          'focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1',
        )}
      />

      {/*
        Locked cells carry a glyph inside the cell rather than only a muted
        background, because "why can't I type here?" is asked constantly.
      */}
      {disabled && !isNonNumeric && (
        <span
          aria-hidden="true"
          title="Locked — read only"
          className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-faint"
        >
          <IconLock size={12} />
        </span>
      )}

      {showError && (
        <p id={errorId} role="alert" className="mt-1 flex items-start gap-1 text-2xs font-medium text-danger-strong">
          <IconAlertCircle size={11} className="mt-px shrink-0" />
          {validation.message ?? 'Invalid mark'}
        </p>
      )}

      {edited && !showError && !disabled && (
        <p id={noteId} className="sr-only">
          Edited and not yet saved
        </p>
      )}
    </div>
  );
}

/** Visually hidden description used for the invalid-value announcement. */
export function MarkCellError({ id, message }: { id: string; message: string }) {
  return (
    <span id={id} role="alert" className="sr-only">
      {message}
    </span>
  );
}

/**
 * Compact read-only display used in the review screen.
 *
 * A non-numeric status replaces the number entirely. Showing `0` for an absent
 * student would read as "scored zero" on a report card.
 */
export function MarkValue({
  marks,
  status,
  maxMarks,
}: {
  marks: number | null;
  status: MarkStatus;
  maxMarks?: number;
}) {
  if (status !== 'PRESENT') {
    return (
      <span className="inline-flex items-center rounded bg-surface-sunken px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-ink-muted">
        {status}
      </span>
    );
  }

  return (
    <span className="tabular">
      {formatMark(marks)}
      {maxMarks !== undefined && <span className="text-ink-faint">/{formatMark(maxMarks)}</span>}
    </span>
  );
}
