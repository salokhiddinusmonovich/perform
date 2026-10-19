// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ColumnDef } from '@tanstack/react-table';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { DataTable } from './data-table';

interface Row {
  name: string;
  team: string;
}

const columns: ColumnDef<Row, unknown>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'team', header: 'Team' },
];

const rows: Row[] = [
  { name: 'Worker B', team: 'Electrical' },
  { name: 'Worker A', team: 'Mechanical' },
  { name: 'Worker C', team: 'Electrical' },
];

beforeAll(() => i18n.changeLanguage('en'));
afterEach(cleanup);

const bodyRows = () => screen.getAllByRole('row').slice(1); // skip header row

describe('DataTable', () => {
  it('renders rows and the total', () => {
    render(<DataTable columns={columns} data={rows} />);
    expect(bodyRows()).toHaveLength(3);
    expect(screen.getByText('3 rows')).toBeTruthy();
  });

  it('filters with the search box and shows a no-results state', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={columns} data={rows} searchable />);
    const search = screen.getByRole('searchbox', { name: 'Search…' });

    await user.type(search, 'mechanical');
    expect(bodyRows()).toHaveLength(1);
    expect(screen.getByText('Worker A')).toBeTruthy();

    await user.clear(search);
    await user.type(search, 'nobody');
    expect(screen.getByText('No results match your search')).toBeTruthy();
  });

  it('sorts when a header is clicked', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={columns} data={rows} />);
    await user.click(screen.getByRole('button', { name: /Name/ }));
    const names = bodyRows().map((r) => within(r).getAllByRole('cell')[0].textContent);
    expect(names).toEqual(['Worker A', 'Worker B', 'Worker C']);
  });

  it('shows the empty state when there is no data', () => {
    render(<DataTable columns={columns} data={[]} emptyTitle="No workers yet" />);
    expect(screen.getByText('No workers yet')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the error state with a working retry button', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<DataTable columns={columns} data={undefined} isError onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows skeleton rows while loading, not the empty state', () => {
    render(<DataTable columns={columns} data={undefined} isLoading />);
    expect(screen.queryByText('Nothing here yet')).toBeNull();
    expect(screen.getAllByRole('row', { hidden: true }).length).toBeGreaterThan(1);
  });

  it('paginates', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `Worker ${i + 1}`, team: 'X' }));
    render(<DataTable columns={columns} data={many} pageSize={25} />);
    expect(bodyRows()).toHaveLength(25);
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(bodyRows()).toHaveLength(5);
  });
});
