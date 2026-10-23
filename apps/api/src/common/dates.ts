/** "YYYY-MM-DD" of a @db.Date column. */
export const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** A calendar day "YYYY-MM-DD" as the Date Prisma stores in a @db.Date column. */
export const dayToDate = (day: string) => new Date(`${day}T00:00:00Z`);

/** The calendar day before `day`. */
export function previousDay(day: string): string {
  const date = dayToDate(day);
  date.setUTCDate(date.getUTCDate() - 1);
  return isoDay(date);
}

export const monthOfDay = (day: string) => ({ year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) });

/** Today in the company's time zone (timesheet days follow the company's clock). */
export function todayIn(timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(),
  );
}

/** Placements that are current on `day`: started on or before it and not ended before it. */
export const currentOn = (day: string) => ({
  hiredOn: { lte: dayToDate(day) },
  OR: [{ leftOn: null }, { leftOn: { gte: dayToDate(day) } }],
});

/** First and last calendar day of a month (1-based), as @db.Date values. */
export function monthSpan(year: number, month: number) {
  return { first: new Date(Date.UTC(year, month - 1, 1)), last: new Date(Date.UTC(year, month, 0)) };
}

/** Placements that overlap the month. */
export const inMonth = (year: number, month: number) => {
  const { first, last } = monthSpan(year, month);
  return { hiredOn: { lte: last }, OR: [{ leftOn: null }, { leftOn: { gte: first } }] };
};
