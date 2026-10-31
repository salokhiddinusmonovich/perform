import { describe, expect, it } from 'vitest';
import { NO_TEAM, rowTeams } from './timesheet';

describe('rowTeams', () => {
  it('lists each team once by name, with rows without a team last', () => {
    expect(
      rowTeams([
        { teamId: null, teamName: null },
        { teamId: 'b', teamName: 'Welders' },
        { teamId: 'a', teamName: 'Carpenters' },
        { teamId: 'b', teamName: 'Welders' },
      ]),
    ).toEqual([
      { key: 'a', name: 'Carpenters' },
      { key: 'b', name: 'Welders' },
      { key: NO_TEAM, name: null },
    ]);
  });

  it('is empty without rows', () => {
    expect(rowTeams([])).toEqual([]);
  });
});
