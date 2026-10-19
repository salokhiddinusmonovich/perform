import type { CalendarDay } from './calendar';
import type { DayEntry } from './entry';

export interface HoursSummary {
  /** Hours on workdays up to the standard day length. */
  normalHours: number;
  /** Hours on workdays above the standard day length. */
  overtimeHours: number;
  /** Hours worked on rest days and holidays. */
  restDayHours: number;
  /** Workdays with any hours worked. */
  daysWorked: number;
  absentDays: number;
  leaveDays: number;
  sickDays: number;
  travelDays: number;
}

/**
 * Splits a worker's month into hour buckets. Pay policy (rates, multipliers,
 * which absences are paid) is applied later, on top of this summary.
 */
export function summarizeMonth(
  calendar: CalendarDay[],
  entries: DayEntry[],
  standardDayHours: number,
): HoursSummary {
  if (entries.length !== calendar.length) {
    throw new Error(`Expected ${calendar.length} day entries, got ${entries.length}`);
  }
  const s: HoursSummary = {
    normalHours: 0,
    overtimeHours: 0,
    restDayHours: 0,
    daysWorked: 0,
    absentDays: 0,
    leaveDays: 0,
    sickDays: 0,
    travelDays: 0,
  };

  calendar.forEach((day, i) => {
    const e = entries[i];
    switch (e.status) {
      case 'WORKED':
        if (day.kind === 'WORKDAY') {
          s.daysWorked++;
          s.normalHours += Math.min(e.hours, standardDayHours);
          s.overtimeHours += Math.max(e.hours - standardDayHours, 0);
        } else {
          s.restDayHours += e.hours;
        }
        break;
      case 'ABSENT':
        s.absentDays++;
        break;
      case 'LEAVE':
        s.leaveDays++;
        break;
      case 'SICK':
        s.sickDays++;
        break;
      case 'TRAVEL':
        s.travelDays++;
        break;
    }
  });
  return s;
}
