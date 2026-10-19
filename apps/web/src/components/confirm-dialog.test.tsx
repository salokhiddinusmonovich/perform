// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { ConfirmDialog } from './confirm-dialog';

beforeAll(() => i18n.changeLanguage('en'));
afterEach(cleanup);

function Harness({ onConfirm }: { onConfirm: () => unknown }) {
  const [open, setOpen] = useState(true);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title="Deactivate worker?"
      description="Worker TEST USER will be deactivated."
      confirmLabel="Deactivate"
      destructive
      onConfirm={onConfirm}
    />
  );
}

describe('ConfirmDialog', () => {
  it('names what is affected and closes after a successful confirm', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<Harness onConfirm={onConfirm} />);

    expect(screen.getByText('Worker TEST USER will be deactivated.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Deactivate' }));

    expect(onConfirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('closes on cancel without confirming', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('stays open when the action fails', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockRejectedValue(new Error('server error'));
    render(<Harness onConfirm={onConfirm} />);

    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deactivate' })).toBeTruthy());
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
});
