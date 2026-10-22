import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  holidaySchema,
  payRulesSchema,
  workingDaysOverrideSchema,
  yearMonthSchema,
  yearQuerySchema,
  type Holiday,
  type PayRules,
  type WorkingDaysOverride,
  type YearMonth,
  type YearQuery,
} from '@puantaj/schemas';
import { CompanyAuth, ForModule, Roles, type CompanyAuthContext } from '../auth/auth.context';
import { ZodPipe } from '../common/zod.pipe';
import { HolidaysService, type HolidayYearView } from './holidays.service';
import { PayRulesService, type PayRulesVersionView } from './pay-rules.service';
import { WorkingDaysService, type WorkingDaysYearView } from './working-days.service';

// Owners and admins change pay rules and holidays; accountants see them (AGENTS.md: Roles).
// Timekeepers and foremen never see pay settings.

/** Pay rules of the company, versioned by the month they apply from. */
@ForModule('PAYROLL')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
@Controller('pay-rules')
export class PayRulesController {
  constructor(private readonly rules: PayRulesService) {}

  @Get()
  list(@CompanyAuth() auth: CompanyAuthContext): Promise<PayRulesVersionView[]> {
    return this.rules.list(auth.company.id);
  }

  @Put(':year/:month')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  set(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param(new ZodPipe(yearMonthSchema)) from: YearMonth,
    @Body(new ZodPipe(payRulesSchema)) body: PayRules,
  ): Promise<void> {
    return this.rules.set(auth, from, body);
  }

  @Delete(':year/:month')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  remove(@CompanyAuth() auth: CompanyAuthContext, @Param(new ZodPipe(yearMonthSchema)) from: YearMonth): Promise<void> {
    return this.rules.remove(auth, from);
  }
}

/** Holidays the company enters; Uzbekistan's fixed-date holidays come with the app. */
@ForModule('PAYROLL')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
@Controller('holidays')
export class HolidaysController {
  constructor(private readonly holidays: HolidaysService) {}

  @Get()
  year(
    @CompanyAuth() auth: CompanyAuthContext,
    @Query(new ZodPipe(yearQuerySchema)) { year }: YearQuery,
  ): Promise<HolidayYearView> {
    return this.holidays.year(auth.company.id, year);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  create(@CompanyAuth() auth: CompanyAuthContext, @Body(new ZodPipe(holidaySchema)) body: Holiday) {
    return this.holidays.create(auth, body);
  }

  @Put(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  update(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(holidaySchema)) body: Holiday,
  ): Promise<void> {
    return this.holidays.update(auth, id, body);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  remove(@CompanyAuth() auth: CompanyAuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.holidays.remove(auth, id);
  }
}

/** Working days per month: calculated, overridden, and the value pay uses. */
@ForModule('PAYROLL')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
@Controller('working-days')
export class WorkingDaysController {
  constructor(private readonly workingDays: WorkingDaysService) {}

  @Get()
  year(
    @CompanyAuth() auth: CompanyAuthContext,
    @Query(new ZodPipe(yearQuerySchema)) { year }: YearQuery,
  ): Promise<WorkingDaysYearView> {
    return this.workingDays.year(auth.company.id, year);
  }

  @Post(':year/:month')
  @HttpCode(204)
  override(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param(new ZodPipe(yearMonthSchema)) month: YearMonth,
    @Body(new ZodPipe(workingDaysOverrideSchema)) body: WorkingDaysOverride,
  ): Promise<void> {
    return this.workingDays.override(auth, month, body);
  }
}
