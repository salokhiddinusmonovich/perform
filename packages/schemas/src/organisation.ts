import { z } from 'zod';
import { phoneSchema } from './contact.js';
import { calendarDaySchema, decimalSchema, isoDateSchema, MAX_YEAR, monthSchema, yearSchema } from './pay-rules.js';

// Sites, teams and workers. Optional text fields turn an empty value into null, and
// accept null, so the API can validate what a form sends (the schema's own output).

const requiredName = (max: number) =>
  z
    .string({ error: 'validation.required' })
    .trim()
    .min(1, { error: 'validation.required', abort: true })
    .max(max, { error: 'validation.tooLong' });

export const optionalText = (max: number) =>
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

/**
 * A brigade on a site. Its department (AGENTS.md: Departments) is required by the API while
 * the company uses departments, and fixed once a placement has it.
 */
export const teamSchema = z.object({
  siteId: uuid,
  name: requiredName(120),
  departmentId: optionalUuid,
});
export type TeamInput = z.input<typeof teamSchema>;
export type Team = z.output<typeof teamSchema>;

export const updateTeamSchema = teamSchema
  .omit({ siteId: true })
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: 'validation.nothingToUpdate' });
export type UpdateTeam = z.output<typeof updateTeamSchema>;

/** Mirrors EmploymentType in apps/api/prisma/schema.prisma. */
export const EMPLOYMENT_TYPES = ['DIRECT', 'INDIRECT'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/** Uzbek personal ID: 14 digits. */
const pinflSchema = z
  .string()
  .nullish()
  .transform((value) => (value ? value.replace(/\s/g, '') : null))
  .pipe(z.string().regex(/^\d{14}$/, { error: 'validation.pinflInvalid' }).nullable());

/** A worker's own details. Personal data (PINFL, passport, birth date, phone) is never sent to timekeepers or foremen. */
export const workerSchema = z.object({
  /** The company's own number for the worker (e.g. SICIL); Excel imports recognise workers by it. */
  employeeNumber: optionalText(30),
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

/**
 * Where a worker works from a date on. The department (AGENTS.md: Departments) is the
 * team's when there is a team; without one it is required by the API while the company
 * uses departments.
 */
export const placementSchema = z.object({
  siteId: uuid,
  teamId: optionalUuid,
  departmentId: optionalUuid,
  /** First day at this site (the hire date for a new worker). */
  from: isoDateSchema,
});
export type PlacementInput = z.input<typeof placementSchema>;
export type Placement = z.output<typeof placementSchema>;

/** Fills in the department of a placement that has none (placements from before departments were used). */
export const placementDepartmentSchema = z.object({ departmentId: uuid });
export type PlacementDepartmentInput = z.input<typeof placementDepartmentSchema>;
export type PlacementDepartment = z.output<typeof placementDepartmentSchema>;

/**
 * A company's department (AGENTS.md: Departments): a name, an optional short code, and the
 * department it sits under (none: top level).
 */
export const departmentSchema = z.object({
  name: requiredName(80),
  code: optionalText(20),
  parentId: optionalUuid,
});
export type DepartmentInput = z.input<typeof departmentSchema>;
export type Department = z.output<typeof departmentSchema>;

/** Renaming, moving under another department, or (de)activating one. */
export const updateDepartmentSchema = departmentSchema
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: 'validation.nothingToUpdate' });
export type UpdateDepartment = z.output<typeof updateDepartmentSchema>;

/** Whether the company uses departments (every new placement then needs one). */
export const departmentSettingsSchema = z.object({ enabled: z.boolean() });
export type DepartmentSettingsInput = z.input<typeof departmentSettingsSchema>;
export type DepartmentSettings = z.output<typeof departmentSettingsSchema>;

export const createWorkerSchema = z.object({ worker: workerSchema, placement: placementSchema });
export type CreateWorkerInput = z.input<typeof createWorkerSchema>;
export type CreateWorker = z.output<typeof createWorkerSchema>;

/** The worker's last working day. */
export const leaveSchema = z.object({ date: isoDateSchema });
export type LeaveInput = z.input<typeof leaveSchema>;
export type Leave = z.output<typeof leaveSchema>;

/**
 * A worker's monthly salary from a month on, covering that month and later ones until a
 * newer salary (AGENTS.md: Roles → Salaries). Salaries are only ever added; a correction
 * is a new salary from the same month.
 */
export const salarySchema = z.object({
  fromYear: yearSchema,
  fromMonth: monthSchema,
  /** More than 0: the hourly rate is worked out from it. Fits Decimal(14,2). */
  monthlySalary: decimalSchema({ min: 0, minExclusive: true, max: 999_999_999_999, rangeError: 'validation.salaryRange' }),
  reason: optionalText(500),
});
export type SalaryInput = z.input<typeof salarySchema>;
export type Salary = z.output<typeof salarySchema>;

/**
 * A company's shift with its own normal hours per day (AGENTS.md: Shifts). Same range as
 * the pay rules' normal hours per day.
 */
export const shiftSchema = z.object({
  name: requiredName(60),
  normalHoursPerDay: decimalSchema({ min: 0, minExclusive: true, max: 24, rangeError: 'validation.normalHoursRange' }),
});
export type ShiftInput = z.input<typeof shiftSchema>;
export type Shift = z.output<typeof shiftSchema>;

/** Renaming a shift, changing its hours while nobody has had it, or (de)activating it. */
export const updateShiftSchema = shiftSchema
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: 'validation.nothingToUpdate' });
export type UpdateShift = z.output<typeof updateShiftSchema>;

/** A worker's shift from a day on, until a newer one. No shift (null): the rule set's normal hours. */
export const workerShiftSchema = z.object({
  shiftId: optionalUuid,
  from: isoDateSchema,
});
export type WorkerShiftInput = z.input<typeof workerShiftSchema>;
export type WorkerShift = z.output<typeof workerShiftSchema>;

/** The same shift from a day for many workers at once ("night shift from day X"). */
export const workerShiftsSchema = workerShiftSchema.extend({
  workerIds: z
    .array(uuid)
    .min(1, { error: 'validation.chooseWorkers' })
    .max(1000, { error: 'validation.tooMany' })
    .refine((ids) => new Set(ids).size === ids.length, { error: 'validation.invalid' }),
});
export type WorkerShiftsInput = z.input<typeof workerShiftsSchema>;
export type WorkerShifts = z.output<typeof workerShiftsSchema>;

/** Assigning a company member to a site (project manager, timekeeper) or a team (foreman). */
export const staffSchema = z.object({ userId: uuid });
export type StaffInput = z.input<typeof staffSchema>;
