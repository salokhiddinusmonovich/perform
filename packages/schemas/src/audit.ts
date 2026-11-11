import { z } from 'zod';

// The audit trail (AGENTS.md: Audit, Platform admin). Every action the API records is
// listed here, so the API can only record known actions and every one has a name in
// each language.

export const AUDIT_ACTIONS = [
  'adjustment.add',
  'adjustment.cancel',
  'auth.login',
  'auth.passwordChanged',
  'auth.sessionRevoked',
  'company.activate',
  'company.create',
  'company.deactivate',
  'company.departments',
  'company.firms',
  'company.payment',
  'company.planChange',
  'company.update',
  'department.create',
  'department.update',
  'firm.create',
  'firm.update',
  'holiday.create',
  'holiday.delete',
  'holiday.update',
  'impersonation.end',
  'impersonation.start',
  'importMapping.set',
  'member.add',
  'member.invitationAccepted',
  'member.invitationDeclined',
  'member.invite',
  'member.passwordReset',
  'member.update',
  'monthlyHours.add',
  'payCategories.delete',
  'payCategories.set',
  'payRounding.delete',
  'payRounding.set',
  'payRules.delete',
  'payRules.set',
  'period.lock',
  'period.unlock',
  'plan.create',
  'plan.update',
  'platform.adminCreated',
  'platform.adminGranted',
  'ruleSet.addVariant',
  'ruleSet.create',
  'ruleSet.update',
  'ruleSet.use',
  'ruleSet.useDelete',
  'salary.add',
  'shift.create',
  'shift.update',
  'site.create',
  'site.staffAdd',
  'site.staffRemove',
  'site.update',
  'team.create',
  'team.foremanAdd',
  'team.foremanRemove',
  'team.update',
  'timesheetCodes.set',
  'timesheetEntry.create',
  'timesheetEntry.delete',
  'timesheetEntry.update',
  'timesheetImport.create',
  'timesheetImport.worker',
  'timesheetSettings.set',
  'travelAmount.add',
  'travelRoute.create',
  'travelRoute.update',
  'user.create',
  'user.passwordReset',
  'user.update',
  'worker.create',
  'worker.leave',
  'worker.place',
  'worker.placementDepartment',
  'worker.placementFirm',
  'worker.placementTravelRoute',
  'worker.update',
  'workerCategory.addOption',
  'workerCategory.create',
  'workerCategory.update',
  'workerCategory.updateOption',
  'workerImport.create',
  'workerShift.add',
  'workerShift.correct',
  'workerShift.remove',
  'workingDays.override',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** What an action is about: the part before the dot, e.g. "worker" for "worker.create". */
export type AuditArea = AuditAction extends `${infer Area}.${string}` ? Area : never;
export const auditAreaOf = (action: AuditAction) => action.slice(0, action.indexOf('.')) as AuditArea;
export const AUDIT_AREAS = [...new Set(AUDIT_ACTIONS.map(auditAreaOf))] as [AuditArea, ...AuditArea[]];

/** Sign-ins far outnumber everything else, so lists leave them out unless asked. */
export const LOGIN_ACTION = 'auth.login' satisfies AuditAction;

/** How many entries one page of the audit list holds. */
export const AUDIT_PAGE_SIZE = 100;

const optionalUuid = z.uuid({ error: 'validation.invalid' }).optional();
const optionalTimestamp = z.iso.datetime({ offset: true, error: 'validation.invalid' }).optional();

/**
 * `GET /platform/audit`: newest first, a page at a time. `userId` finds what a person did,
 * did as someone else (impersonation), or had done to their account. `before` is the
 * `nextCursor` of the previous page.
 */
export const auditQuerySchema = z
  .object({
    companyId: optionalUuid,
    userId: optionalUuid,
    area: z.enum(AUDIT_AREAS, { error: 'validation.invalid' }).optional(),
    logins: z
      .enum(['true', 'false'], { error: 'validation.invalid' })
      .optional()
      .transform((v) => v === 'true'),
    from: optionalTimestamp,
    to: optionalTimestamp,
    before: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z_[0-9a-f-]{36}$/, { error: 'validation.invalid' })
      .optional(),
  })
  .refine((q) => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to), { error: 'validation.invalid', path: ['to'] });
export type AuditQueryInput = z.input<typeof auditQuerySchema>;
export type AuditQuery = z.output<typeof auditQuerySchema>;
