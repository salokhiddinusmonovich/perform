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
