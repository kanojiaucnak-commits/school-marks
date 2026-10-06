import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MarkCell, MarkValue } from './MarkCell';

/**
 * Keyboard behaviour of the marks cell.
 *
 * This is the interaction a teacher spends the whole day inside, so it is worth
 * testing properly: entering forty marks must never require the mouse, and no
 * keystroke may be able to produce a value the server would reject.
 */

function setup(overrides: Partial<Parameters<typeof MarkCell>[0]> = {}) {
  const onCommit = vi.fn();
  const onNavigate = vi.fn();

  const { rerender } = render(
    <MarkCell
      value={null}
      maxMarks={100}
      status="PRESENT"
      disabled={false}
      onCommit={onCommit}
      onNavigate={onNavigate}
      rowIndex={0}
      columnIndex={0}
      {...overrides}
    />,
  );

  return {
    onCommit,
    onNavigate,
    rerender,
    input: screen.getByRole('textbox') as HTMLInputElement,
  };
}

describe('MarkCell — keyboard navigation', () => {
  it('moves down and commits on Enter', async () => {
    const user = userEvent.setup();
    const { input, onCommit, onNavigate } = setup();

    await user.type(input, '87{Enter}');

    expect(onCommit).toHaveBeenCalledWith('87', 'PRESENT');
    expect(onNavigate).toHaveBeenCalledWith(1, true);
  });

  it('moves up on Shift+Enter', async () => {
    const user = userEvent.setup();
    const { input, onNavigate } = setup();

    await user.type(input, '87{Shift>}{Enter}{/Shift}');

    expect(onNavigate).toHaveBeenCalledWith(-1, true);
  });

  it('moves down on ArrowDown and up on ArrowUp', async () => {
    const user = userEvent.setup();
    const { input, onNavigate } = setup();

    await user.click(input);
    await user.keyboard('{ArrowDown}');
    expect(onNavigate).toHaveBeenLastCalledWith(1, true);

    await user.keyboard('{ArrowUp}');
    expect(onNavigate).toHaveBeenLastCalledWith(-1, true);
  });

  it('commits before navigating, so the value is never lost', async () => {
    const user = userEvent.setup();
    const { input, onCommit, onNavigate } = setup();

    await user.type(input, '42');
    onNavigate.mockClear();

    await user.keyboard('{Enter}');

    // Navigation must not happen without the value being handed upwards first.
    expect(onCommit).toHaveBeenCalledWith('42', 'PRESENT');
    expect(onNavigate).toHaveBeenCalled();
  });

  it('does not commit twice for a single Enter', async () => {
    const user = userEvent.setup();
    const { input, onCommit } = setup();

    await user.type(input, '55{Enter}');

    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('moves to the previous row only when the caret is at the start', async () => {
    const user = userEvent.setup();
    const { input, onNavigate } = setup();

    await user.type(input, '12');

    // Caret is at the end, so ArrowLeft must behave like a normal text key.
    await user.keyboard('{ArrowLeft}');
    expect(onNavigate).not.toHaveBeenCalled();

    await user.keyboard('{Home}{ArrowLeft}');
    expect(onNavigate).toHaveBeenCalledWith(-1, true);
  });

  it('moves to the next row only when the caret is at the end', async () => {
    const user = userEvent.setup();
    const { input, onNavigate } = setup();

    await user.type(input, '12{ArrowRight}');
    expect(onNavigate).toHaveBeenCalledWith(1, true);
  });

  it('commits on blur, so tabbing away never discards an edit', async () => {
    const user = userEvent.setup();
    const { input, onCommit } = setup();

    await user.type(input, '73');
    await user.tab();

    expect(onCommit).toHaveBeenCalledWith('73', 'PRESENT');
  });
});

describe('MarkCell — input sanitising', () => {
  it('rejects letters outright rather than sending them to the server', async () => {
    const user = userEvent.setup();
    const { input } = setup();

    await user.type(input, '8a7b');

    expect(input.value).toBe('87');
  });

  it('allows a decimal point', async () => {
    const user = userEvent.setup();
    const { input } = setup();

    await user.type(input, '12.5');

    expect(input.value).toBe('12.5');
  });

  it('blocks a minus sign, because a negative mark can never be valid', async () => {
    const user = userEvent.setup();
    const { input } = setup();

    // `marks_obtained >= 0` is a database constraint, so a negative value could
    // never be saved. Rejecting the keystroke is clearer than accepting it and
    // then showing an error.
    await user.type(input, '-1.5');

    expect(input.value).toBe('1.5');
  });

  it('marks an out-of-range value as invalid for assistive technology', async () => {
    const user = userEvent.setup();
    const { input } = setup();

    await user.type(input, '101');

    // The cell still holds what was typed so the teacher can see and fix it,
    // but it is announced as invalid.
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('does not flag a value that equals the maximum', async () => {
    const user = userEvent.setup();
    const { input } = setup();

    await user.type(input, '100');

    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('disables the input when the status is non-numeric', () => {
    const { input } = setup({ status: 'ABSENT', value: null });

    // A medical absence carries no number; an editable box would invite one.
    expect(input).toBeDisabled();
  });

  it('shows no value at all for a non-numeric status', () => {
    const { input } = setup({ status: 'MEDICAL', value: null });

    // Because the cell is disabled it can never take a keystroke or a blur, so
    // the guarantee is structural: there is nothing to submit. A stray 0 would
    // read as "scored zero" on a report card.
    expect(input).toBeDisabled();
    expect(input).toHaveValue('');
  });

  it('is disabled and shows the value when the sheet is locked', () => {
    const { input } = setup({ disabled: true, value: 88 });

    expect(input).toBeDisabled();
    expect(input).toHaveValue('88');
  });

  it('adopts a server value when the user is not mid-edit', () => {
    const { rerender, input } = setup({ value: 40 });
    expect(input).toHaveValue('40');

    rerender(
      <MarkCell
        value={55}
        maxMarks={100}
        status="PRESENT"
        disabled={false}
        onCommit={vi.fn()}
        onNavigate={vi.fn()}
        rowIndex={0}
        columnIndex={0}
      />,
    );

    expect(input).toHaveValue('55');
  });

  it('keeps a half-typed value when the server value changes underneath', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();

    const { rerender, input } = setup({ value: 40, onCommit });

    // The teacher is typing "8" on the way to "87" when a background refresh
    // pushes the old value back. The caret must not be yanked.
    await user.type(input, '8');

    rerender(
      <MarkCell
        value={40}
        maxMarks={100}
        status="PRESENT"
        disabled={false}
        onCommit={onCommit}
        onNavigate={vi.fn()}
        rowIndex={0}
        columnIndex={0}
      />,
    );

    expect(input).toHaveValue('8');
  });
});

describe('MarkValue — read-only display', () => {
  it('shows a numeric mark with its maximum', () => {
    render(<MarkValue marks={88} status="PRESENT" maxMarks={100} />);

    expect(screen.getByText('88')).toBeInTheDocument();
    expect(screen.getByText('/100')).toBeInTheDocument();
  });

  it('shows the status instead of a misleading zero', () => {
    render(<MarkValue marks={null} status="ABSENT" maxMarks={100} />);

    // Zero here would read as "scored zero" rather than "was not present".
    expect(screen.getByText('ABSENT')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('shows a dash for an empty mark', () => {
    render(<MarkValue marks={null} status="PRESENT" maxMarks={100} />);

    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
