import { z } from 'zod';
import type { Role } from './company.js';
import { optionalText } from './organisation.js';
import { decimalSchema, isoDateSchema } from './pay-rules.js';

// Daily hour entry (AGENTS.md: Hour entry, Mobile app).

/** Roles a company can let enter hours. Owners and admins always may. */
export const ENTRY_ROLES = ['TIMEKEEPER', 'FOREMAN'] as const satisfies readonly Role[];
export type EntryRole = (typeof ENTRY_ROLES)[number];

/** A new company's setting (AGENTS.md): the timekeeper enters hours. */
export const DEFAULT_ENTRY_ROLES: readonly EntryRole[] = ['TIMEKEEPER'];

/** Who enters daily hours (Settings). Owners and admins only. */
export const timesheetSettingsSchema = z.object({
  entryRoles: z
    .array(z.enum(ENTRY_ROLES, { error: 'validation.invalid' }), { error: 'validation.invalid' })
    .transform((roles) => ENTRY_ROLES.filter((r) => roles.includes(r)))
    .refine((roles) => roles.length > 0, { error: 'validation.entryRolesRequired' }),
});
export type TimesheetSettingsInput = z.input<typeof timesheetSettingsSchema>;
export type TimesheetSettings = z.output<typeof timesheetSettingsSchema>;

/**
 * Day statuses entered by hand (DayStatus in @puantaj/payroll). OFF and NOT_EMPLOYED
 * aren't: a day without an entry is simply not recorded, and employment follows from
 * the worker's placements.
 */
export const ENTRY_STATUSES = ['WORKED', 'ABSENT', 'LEAVE', 'SICK', 'TRAVEL'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

/** Hours worked at one site on one day. */
export const dayHoursSchema = decimalSchema({ min: 0, minExclusive: true, max: 24, rangeError: 'validation.dayHoursRange' });

/**
 * One worker's day at one site/team, written by its id (PUT /timesheet/entries/:id).
 * The client makes the id (a UUID), so a phone can create entries offline and a retry
 * never creates a second one. `version` is the version the client last saw: absent
 * when it creates the entry, required to change it, so stale data is refused.
 * Hours belong to WORKED only; any other status is the worker's whole day.
 */
export const timesheetEntrySchema = z
  .object({
    workerId: z.uuid({ error: 'validation.required' }),
    siteId: z.uuid({ error: 'validation.required' }),
    teamId: z.uuid({ error: 'validation.invalid' }).nullable(),
    date: isoDateSchema,
    status: z.enum(ENTRY_STATUSES, { error: 'validation.required' }),
    hours: z.string().nullish(),
    note: optionalText(500),
    version: z.number({ error: 'validation.invalid' }).int({ error: 'validation.invalid' }).min(1).optional(),
  })
  .transform((entry, ctx) => {
    if (entry.status !== 'WORKED') return { ...entry, hours: '0' };
    const hours = dayHoursSchema.safeParse(entry.hours ?? '');
    if (hours.success) return { ...entry, hours: hours.data };
    for (const issue of hours.error.issues) ctx.addIssue({ code: 'custom', path: ['hours'], message: issue.message });
    return z.NEVER;
  });
export type TimesheetEntryInput = z.input<typeof timesheetEntrySchema>;
export type TimesheetEntry = z.output<typeof timesheetEntrySchema>;

/** `?version=3` on DELETE /timesheet/entries/:id: the version the client last saw. */
export const entryVersionQuerySchema = z.object({
  version: z.coerce.number({ error: 'validation.invalid' }).int({ error: 'validation.invalid' }).min(1, { error: 'validation.invalid' }),
});
export type EntryVersionQuery = z.output<typeof entryVersionQuerySchema>;

/** `?siteId=…` of the month's grid. */
export const timesheetQuerySchema = z.object({ siteId: z.uuid({ error: 'validation.required' }) });
export type TimesheetQuery = z.output<typeof timesheetQuerySchema>;

/** What a company's own code can stand for (DayStatus without WORKED: hours are typed as a number). */
export const CODE_STATUSES = ['ABSENT', 'LEAVE', 'SICK', 'TRAVEL', 'OFF', 'NOT_EMPLOYED'] as const;
export type CodeStatus = (typeof CODE_STATUSES)[number];

/** Statuses typed with a code in the daily grid. OFF and NOT_EMPLOYED codes are for Excel imports only. */
export const GRID_CODE_STATUSES = ['ABSENT', 'LEAVE', 'SICK', 'TRAVEL'] as const satisfies readonly CodeStatus[];

const isGridStatus = (status: CodeStatus) => (GRID_CODE_STATUSES as readonly CodeStatus[]).includes(status);

/**
 * A company's own codes (Settings, owners and admins), the same list for the grid and for
 * Excel imports, so everyone types the same letters in any language. Each grid status
 * that has codes shows with exactly one of them (inGrid). The API also refuses two codes
 * that are the same once normalized (normalizeCode in @puantaj/payroll), e.g. "iz" and "IZ".
 */
export const timesheetCodesSchema = z
  .object({
    codes: z
      .array(
        z.object({
          code: z
            .string({ error: 'validation.required' })
            .trim()
            .min(1, { error: 'validation.required' })
            .max(10, { error: 'validation.tooLong' })
            // A number in a cell is hours worked.
            .refine((code) => !/^\d+(?:[.,]\d*)?$/.test(code), { error: 'validation.codeIsNumber' }),
          status: z.enum(CODE_STATUSES, { error: 'validation.required' }),
          inGrid: z.boolean(),
        }),
      )
      .max(100, { error: 'validation.tooMany' }),
  })
  .superRefine(({ codes }, ctx) => {
    for (const status of GRID_CODE_STATUSES) {
      const rows = codes.flatMap((c, i) => (c.status === status ? [{ ...c, i }] : []));
      const shown = rows.filter((c) => c.inGrid);
      if (rows.length > 0 && shown.length !== 1) {
        ctx.addIssue({ code: 'custom', path: ['codes', rows[0].i, 'inGrid'], message: 'validation.gridCodeOne' });
      }
    }
    codes.forEach((c, i) => {
      if (c.inGrid && !isGridStatus(c.status)) {
        ctx.addIssue({ code: 'custom', path: ['codes', i, 'inGrid'], message: 'validation.gridCodeNotForStatus' });
      }
    });
  });
export type TimesheetCodesInput = z.input<typeof timesheetCodesSchema>;
export type TimesheetCodes = z.output<typeof timesheetCodesSchema>;
