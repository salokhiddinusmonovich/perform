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
export const optionalUuid = z
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
  /**
   * The worker's option in each category (AGENTS.md: Worker categories), by category id; null
   * clears it. Categories left out keep what they have.
   */
  categories: z.record(z.uuid({ error: 'validation.invalid' }), optionalUuid).default({}),
  /**
   * The month changed options start from (AGENTS.md: Worker categories); required by the API
   * when an existing worker's options change. A new worker's start from their first placement.
   */
  categoriesFrom: z.object({ year: yearSchema, month: monthSchema }).nullish().transform((v) => v ?? null),
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
  /** The employer (AGENTS.md: Firms); required by the API while the company uses firms. */
  firmId: optionalUuid,
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

/** Mirrors FirmType in apps/api/prisma/schema.prisma. */
export const FIRM_TYPES = ['OWN', 'SUBCONTRACTOR'] as const;
export type FirmType = (typeof FIRM_TYPES)[number];

/** An employer inside the company (AGENTS.md: Firms). The type never changes how pay is worked out. */
export const firmSchema = z.object({
  name: requiredName(120),
  type: z.enum(FIRM_TYPES, { error: 'validation.required' }),
});
export type FirmInput = z.input<typeof firmSchema>;
export type Firm = z.output<typeof firmSchema>;

/** Renaming, changing the type of, or (de)activating a firm. */
export const updateFirmSchema = firmSchema
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: 'validation.nothingToUpdate' });
export type UpdateFirm = z.output<typeof updateFirmSchema>;

/**
 * A company's own way of grouping workers (AGENTS.md: Worker categories), created with its
 * options (at least two, names unique ignoring case).
 */
export const workerCategorySchema = z.object({
  name: requiredName(80),
  options: z
    .array(requiredName(80))
    .min(2, { error: 'validation.twoOptions' })
    .max(50, { error: 'validation.tooMany' })
    .refine((names) => new Set(names.map((n) => n.toLowerCase())).size === names.length, {
      error: 'validation.optionTwice',
    }),
});
export type WorkerCategoryInput = z.input<typeof workerCategorySchema>;
export type WorkerCategory = z.output<typeof workerCategorySchema>;

/** Renaming or (de)activating a category. */
export const updateWorkerCategorySchema = z
  .object({ name: requiredName(80).optional(), isActive: z.boolean().optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: 'validation.nothingToUpdate' });
export type UpdateWorkerCategory = z.output<typeof updateWorkerCategorySchema>;

/** A new option of a category. */
export const categoryOptionSchema = z.object({ name: requiredName(80) });
export type CategoryOptionInput = z.input<typeof categoryOptionSchema>;
export type CategoryOption = z.output<typeof categoryOptionSchema>;

/** Renaming or (de)activating an option. */
export const updateCategoryOptionSchema = categoryOptionSchema
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: 'validation.nothingToUpdate' });
export type UpdateCategoryOption = z.output<typeof updateCategoryOptionSchema>;

/** A named rule set that sites and firms share (AGENTS.md: Pay rule sets). */
export const ruleSetSchema = z.object({ name: requiredName(120) });
export type RuleSetInput = z.input<typeof ruleSetSchema>;
export type RuleSet = z.output<typeof ruleSetSchema>;

/** Renaming or (de)activating a named rule set. */
export const updateRuleSetSchema = ruleSetSchema
  .partial()
  .extend({ isActive: z.boolean().optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: 'validation.nothingToUpdate' });
export type UpdateRuleSet = z.output<typeof updateRuleSetSchema>;

/**
 * The worker categories a rule set splits its rules by from a month on (AGENTS.md: Rule sets
 * split by categories): none, one or two, in the order given.
 */
export const ruleSetSplitSchema = z.object({
  categoryIds: z
    .array(uuid)
    .max(2, { error: 'validation.twoCategoriesAtMost' })
    .refine((ids) => new Set(ids).size === ids.length, { error: 'validation.categoryTwice' }),
});
export type RuleSetSplitInput = z.input<typeof ruleSetSplitSchema>;
export type RuleSetSplit = z.output<typeof ruleSetSplitSchema>;

/** A combination of a split rule set: one option of each of one or two categories. */
export const ruleSetVariantSchema = z.object({
  optionIds: z
    .array(uuid)
    .min(1, { error: 'validation.required' })
    .max(2, { error: 'validation.twoCategoriesAtMost' })
    .refine((ids) => new Set(ids).size === ids.length, { error: 'validation.invalid' }),
});
export type RuleSetVariantInput = z.input<typeof ruleSetVariantSchema>;
export type RuleSetVariant = z.output<typeof ruleSetVariantSchema>;

/** The rule set a site or firm uses from a month; null: none of its own. */
export const ruleSetUseSchema = z.object({ ruleSetId: z.uuid({ error: 'validation.invalid' }).nullable() });
export type RuleSetUseInput = z.input<typeof ruleSetUseSchema>;
export type RuleSetUse = z.output<typeof ruleSetUseSchema>;

/** Whether the company uses firms (every new placement then needs one). */
export const firmSettingsSchema = z.object({ enabled: z.boolean() });
export type FirmSettingsInput = z.input<typeof firmSettingsSchema>;
export type FirmSettings = z.output<typeof firmSettingsSchema>;

/** Fills in the firm of a placement that has none (placements from before firms were used). */
export const placementFirmSchema = z.object({ firmId: uuid });
export type PlacementFirmInput = z.input<typeof placementFirmSchema>;
export type PlacementFirm = z.output<typeof placementFirmSchema>;

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
  /** The firm it is paid by (AGENTS.md: Firms); required by the API while the company uses firms. */
  firmId: optionalUuid,
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
