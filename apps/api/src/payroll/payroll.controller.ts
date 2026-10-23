import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { monthlyHoursSchema, yearMonthSchema, type MonthlyHours, type YearMonth } from '@puantaj/schemas';
import { CompanyAuth, ForModule, Roles, type CompanyAuthContext } from '../auth/auth.context';
import { ZodPipe } from '../common/zod.pipe';
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
}
