import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import {
  holidaySchema,
  payRulesSchema,
  ruleSetPayRulesSchema,
  ruleSetSchema,
  ruleSetSplitSchema,
  ruleSetUseSchema,
  ruleSetVariantSchema,
  updateRuleSetSchema,
  workingDaysOverrideSchema,
  yearMonthSchema,
  yearQuerySchema,
  type Holiday,
  type PayRules,
  type RuleSet,
  type RuleSetPayRules,
  type RuleSetSplit,
  type RuleSetUse,
  type RuleSetVariant,
  type UpdateRuleSet,
  type WorkingDaysOverride,
  type YearMonth,
  type YearQuery,
} from '@puantaj/schemas';
import { CompanyAuth, ForModule, Roles, type CompanyAuthContext } from '../auth/auth.context';
import { ZodPipe } from '../common/zod.pipe';
import { HolidaysService, type HolidayYearView } from './holidays.service';
import {
  PayRulesService,
  type PayRulesVersionView,
  type RuleSetSplitView,
  type RuleSetUseView,
  type RuleSetVariantView,
  type RuleSetView,
} from './pay-rules.service';
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

/**
 * Named rule sets sites and firms share (AGENTS.md: Pay rule sets), with their rules and working
 * days, the same way as the company default's but without a rounding step.
 */
@ForModule('PAYROLL')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
@Controller('rule-sets')
export class RuleSetsController {
  constructor(
    private readonly rules: PayRulesService,
    private readonly workingDays: WorkingDaysService,
  ) {}

  @Get()
  listSets(@CompanyAuth() auth: CompanyAuthContext): Promise<RuleSetView[]> {
    return this.rules.listRuleSets(auth);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  create(@CompanyAuth() auth: CompanyAuthContext, @Body(new ZodPipe(ruleSetSchema)) body: RuleSet) {
    return this.rules.createRuleSet(auth, body);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  update(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateRuleSetSchema)) body: UpdateRuleSet,
  ): Promise<void> {
    return this.rules.updateRuleSet(auth, id, body);
  }

  @Get(':id/pay-rules')
  list(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PayRulesVersionView<RuleSetPayRules>[]> {
    return this.rules.listNamed(auth.company.id, id);
  }

  @Put(':id/pay-rules/:year/:month')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  set(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param(new ZodPipe(yearMonthSchema)) from: YearMonth,
    @Body(new ZodPipe(ruleSetPayRulesSchema)) body: RuleSetPayRules,
  ): Promise<void> {
    return this.rules.setNamed(auth, id, from, body);
  }

  @Delete(':id/pay-rules/:year/:month')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  remove(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param(new ZodPipe(yearMonthSchema)) from: YearMonth,
  ): Promise<void> {
    return this.rules.removeNamed(auth, id, from);
  }

  @Get(':id/working-days')
  workingDaysOfYear(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(yearQuerySchema)) { year }: YearQuery,
  ): Promise<WorkingDaysYearView> {
    return this.workingDays.year(auth.company.id, year, id);
  }

  @Post(':id/working-days/:year/:month')
  @HttpCode(204)
  override(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param(new ZodPipe(yearMonthSchema)) month: YearMonth,
    @Body(new ZodPipe(workingDaysOverrideSchema)) body: WorkingDaysOverride,
  ): Promise<void> {
    return this.workingDays.override(auth, month, body, id);
  }

  /** The categories the set (the company default too) splits by (AGENTS.md: Rule sets split by categories). */
  @Get(':id/splits')
  splits(@CompanyAuth() auth: CompanyAuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<RuleSetSplitView[]> {
    return this.rules.listSplits(auth.company.id, id);
  }

  @Put(':id/splits/:year/:month')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  setSplit(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param(new ZodPipe(yearMonthSchema)) from: YearMonth,
    @Body(new ZodPipe(ruleSetSplitSchema)) body: RuleSetSplit,
  ): Promise<void> {
    return this.rules.setSplit(auth, id, from, body.categoryIds);
  }

  @Delete(':id/splits/:year/:month')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  removeSplit(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param(new ZodPipe(yearMonthSchema)) from: YearMonth,
  ): Promise<void> {
    return this.rules.removeSplit(auth, id, from);
  }

  /** The set's combinations; each one's rules and working days go through the routes above with its own id. */
  @Get(':id/variants')
  variants(@CompanyAuth() auth: CompanyAuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<RuleSetVariantView[]> {
    return this.rules.listVariants(auth.company.id, id);
  }

  @Post(':id/variants')
  @Roles('OWNER', 'ADMIN')
  createVariant(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ruleSetVariantSchema)) body: RuleSetVariant,
  ): Promise<{ id: string }> {
    return this.rules.createVariant(auth, id, body.optionIds);
  }
}

/** The rule set a site uses, from a month on. */
@ForModule('PAYROLL')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
@Controller('sites/:siteId/rule-set')
export class SiteRuleSetController {
  constructor(private readonly rules: PayRulesService) {}

  @Get()
  list(@CompanyAuth() auth: CompanyAuthContext, @Param('siteId', ParseUUIDPipe) siteId: string): Promise<RuleSetUseView[]> {
    return this.rules.listUses(auth.company.id, { siteId });
  }

  @Put(':year/:month')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  set(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param(new ZodPipe(yearMonthSchema)) from: YearMonth,
    @Body(new ZodPipe(ruleSetUseSchema)) body: RuleSetUse,
  ): Promise<void> {
    return this.rules.setUse(auth, { siteId }, from, body.ruleSetId);
  }

  @Delete(':year/:month')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  remove(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param(new ZodPipe(yearMonthSchema)) from: YearMonth,
  ): Promise<void> {
    return this.rules.removeUse(auth, { siteId }, from);
  }
}

/** The rule set a firm uses, from a month on. */
@ForModule('PAYROLL')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
@Controller('firms/:firmId/rule-set')
export class FirmRuleSetController {
  constructor(private readonly rules: PayRulesService) {}

  @Get()
  list(@CompanyAuth() auth: CompanyAuthContext, @Param('firmId', ParseUUIDPipe) firmId: string): Promise<RuleSetUseView[]> {
    return this.rules.listUses(auth.company.id, { firmId });
  }

  @Put(':year/:month')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  set(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('firmId', ParseUUIDPipe) firmId: string,
    @Param(new ZodPipe(yearMonthSchema)) from: YearMonth,
    @Body(new ZodPipe(ruleSetUseSchema)) body: RuleSetUse,
  ): Promise<void> {
    return this.rules.setUse(auth, { firmId }, from, body.ruleSetId);
  }

  @Delete(':year/:month')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  remove(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('firmId', ParseUUIDPipe) firmId: string,
    @Param(new ZodPipe(yearMonthSchema)) from: YearMonth,
  ): Promise<void> {
    return this.rules.removeUse(auth, { firmId }, from);
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
