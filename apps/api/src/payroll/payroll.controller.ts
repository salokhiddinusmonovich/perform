import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  adjustmentSchema,
  cancelAdjustmentSchema,
  monthlyHoursSchema,
  unlockSchema,
  yearMonthSchema,
  type Adjustment,
  type CancelAdjustment,
  type MonthlyHours,
  type Unlock,
  type YearMonth,
} from '@puantaj/schemas';
import { CompanyAuth, ForModule, Roles, type CompanyAuthContext } from '../auth/auth.context';
import { ZodPipe } from '../common/zod.pipe';
import { AdjustmentsService, type AdjustmentsMonthView } from './adjustments.service';
import { MonthlyHoursService, type MonthlyHoursMonthView } from './monthly-hours.service';
import { PayrollService, type PayrollMonthView } from './payroll.service';

// Timekeepers and foremen never see pay (AGENTS.md: Roles), so none of this is theirs.

/** Hours entered as monthly totals per placement. Owners, admins and accountants add them. */
@ForModule('PAYROLL')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
@Controller('monthly-hours')
export class MonthlyHoursController {
  constructor(private readonly hours: MonthlyHoursService) {}

  @Get(':year/:month')
  month(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param(new ZodPipe(yearMonthSchema)) month: YearMonth,
  ): Promise<MonthlyHoursMonthView> {
    return this.hours.month(auth, month);
  }

  /** Only ever added: a correction is a newer entry for the same placement and month. */
  @Post(':year/:month/:assignmentId')
  add(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param(new ZodPipe(yearMonthSchema)) month: YearMonth,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body(new ZodPipe(monthlyHoursSchema)) body: MonthlyHours,
  ): Promise<{ id: string }> {
    return this.hours.add(auth, month, assignmentId, body);
  }
}

/**
 * Bonuses, advances and deductions per worker and month. Owners, admins and accountants
 * add and cancel them; project managers see those on their sites.
 */
@ForModule('PAYROLL')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'PROJECT_MANAGER')
@Controller('adjustments')
export class AdjustmentsController {
  constructor(private readonly adjustments: AdjustmentsService) {}

  @Get(':year/:month')
  month(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param(new ZodPipe(yearMonthSchema)) month: YearMonth,
  ): Promise<AdjustmentsMonthView> {
    return this.adjustments.month(auth, month);
  }

  @Post(':year/:month/:workerId')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  add(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param(new ZodPipe(yearMonthSchema)) month: YearMonth,
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @Body(new ZodPipe(adjustmentSchema)) body: Adjustment,
  ): Promise<{ id: string }> {
    return this.adjustments.add(auth, month, workerId, body);
  }

  /** Never edited or deleted: a mistake is cancelled, with a reason. */
  @Post(':id/cancel')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @HttpCode(204)
  cancel(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(cancelAdjustmentSchema)) body: CancelAdjustment,
  ): Promise<void> {
    return this.adjustments.cancel(auth, id, body.reason);
  }
}

/** Every worker's pay for a month, each amount with the inputs it came from. */
@ForModule('PAYROLL')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'PROJECT_MANAGER')
@Controller('payroll')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Get(':year/:month')
  month(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param(new ZodPipe(yearMonthSchema)) month: YearMonth,
  ): Promise<PayrollMonthView> {
    return this.payroll.month(auth, month);
  }

  /** Locks an ended month whose every worker can be paid, saving a snapshot of it. */
  @Post(':year/:month/lock')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  lock(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param(new ZodPipe(yearMonthSchema)) month: YearMonth,
  ): Promise<{ lockNumber: number }> {
    return this.payroll.lock(auth, month);
  }

  /** Reopens a locked month. Owners only, with a reason. */
  @Post(':year/:month/unlock')
  @Roles('OWNER')
  @HttpCode(204)
  unlock(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param(new ZodPipe(yearMonthSchema)) month: YearMonth,
    @Body(new ZodPipe(unlockSchema)) body: Unlock,
  ): Promise<void> {
    return this.payroll.unlock(auth, month, body.reason);
  }
}
