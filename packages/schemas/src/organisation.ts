import { z } from 'zod';
import { phoneSchema } from './contact.js';
import { calendarDaySchema, isoDateSchema, MAX_YEAR } from './pay-rules.js';

// Sites, teams and workers. Optional text fields turn an empty value into null, and
// accept null, so the API can validate what a form sends (the schema's own output).

const requiredName = (max: number) =>
  z
    .string({ error: 'validation.required' })
    .trim()
    .min(1, { error: 'validation.required', abort: true })
    .max(max, { error: 'validation.tooLong' });

const optionalText = (max: number) =>
  z
    .string()
    .nullish()
    .transform((value) => (value?.trim() ? value.trim() : null))
    .pipe(z.string().max(max, { error: 'validation.tooLong' }).nullable());

const birthDateSchema = z
  .string()
  .nullish()
  .transform((value) => (value?.trim() ? value.trim() : null))
  .pipe(calendarDaySchema(1900, MAX_YEAR).nullable());

const uuid = z.uuid({ error: 'validation.required' });
const optionalUuid = z
  .string()
  .nullish()
  .transform((value) => (value ? value : null))
  .pipe(z.uuid({ error: 'validation.invalid' }).nullable());

export const siteSchema = z.object({
  name: requiredName(120),
  code: optionalText(20),
  address: optionalText(300),
});
export type SiteInput = z.input<typeof siteSchema>;
export type Site = z.output<typeof siteSchema>;

export const updateSiteSchema = siteSchema
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: 'validation.nothingToUpdate' });
export type UpdateSite = z.output<typeof updateSiteSchema>;

export const teamSchema = z.object({
  siteId: uuid,
  name: requiredName(120),
  /** e.g. Electrical, Mechanical */
  department: optionalText(60),
});
export type TeamInput = z.input<typeof teamSchema>;
export type Team = z.output<typeof teamSchema>;

export const updateTeamSchema = teamSchema
  .omit({ siteId: true })
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: 'validation.nothingToUpdate' });
export type UpdateTeam = z.output<typeof updateTeamSchema>;

/** Mirrors EmploymentType and Shift in apps/api/prisma/schema.prisma. */
export const EMPLOYMENT_TYPES = ['DIRECT', 'INDIRECT'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
export const SHIFTS = ['DAY', 'NIGHT'] as const;
export type Shift = (typeof SHIFTS)[number];

/** Uzbek personal ID: 14 digits. */
const pinflSchema = z
  .string()
  .nullish()
  .transform((value) => (value ? value.replace(/\s/g, '') : null))
  .pipe(z.string().regex(/^\d{14}$/, { error: 'validation.pinflInvalid' }).nullable());

/** A worker's own details. Personal data (PINFL, passport, birth date, phone) is never sent to timekeepers or foremen. */
export const workerSchema = z.object({
  lastName: requiredName(80),
  firstName: requiredName(80),
  patronymic: optionalText(80),
  position: optionalText(120),
  employmentType: z.enum(EMPLOYMENT_TYPES, { error: 'validation.required' }),
  pinfl: pinflSchema,
  birthDate: birthDateSchema,
  nationality: optionalText(60),
  passportSeries: z
    .string()
    .nullish()
    .transform((value) => (value?.trim() ? value.trim().toUpperCase() : null))
    .pipe(z.string().max(10, { error: 'validation.tooLong' }).nullable()),
  passportNumber: optionalText(20),
  phone: phoneSchema.transform((value) => value ?? null).or(z.null()),
});
export type WorkerInput = z.input<typeof workerSchema>;
export type Worker = z.output<typeof workerSchema>;

/** Where a worker works from a date on. */
export const placementSchema = z.object({
  siteId: uuid,
  teamId: optionalUuid,
  /** First day at this site (the hire date for a new worker). */
  from: isoDateSchema,
  shift: z.enum(SHIFTS, { error: 'validation.required' }),
});
export type PlacementInput = z.input<typeof placementSchema>;
export type Placement = z.output<typeof placementSchema>;

export const createWorkerSchema = z.object({ worker: workerSchema, placement: placementSchema });
export type CreateWorkerInput = z.input<typeof createWorkerSchema>;
export type CreateWorker = z.output<typeof createWorkerSchema>;

/** The worker's last working day. */
export const leaveSchema = z.object({ date: isoDateSchema });
export type LeaveInput = z.input<typeof leaveSchema>;
export type Leave = z.output<typeof leaveSchema>;

/** Assigning a company member to a site (project manager, timekeeper) or a team (foreman). */
export const staffSchema = z.object({ userId: uuid });
export type StaffInput = z.input<typeof staffSchema>;
