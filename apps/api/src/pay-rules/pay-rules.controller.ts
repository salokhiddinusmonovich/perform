import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import {
  companyRuleSetUseSchema,
  holidaySchema,
  payCategoriesSchema,
  payRoundingSchema,
  payRulesSchema,
  ruleSetSchema,
  ruleSetUseSchema,
  ruleSetVariantSchema,
  updateRuleSetSchema,
  workingDaysOverrideSchema,
  yearMonthSchema,
  yearQuerySchema,
  type CompanyRuleSetUse,
  type Holiday,
  type PayCategories,
  type PayRounding,
  type PayRules,
  type RuleSet,
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
  type PayCategoriesView,
  type PayRoundingView,
  type PayRulesVersionView,
  type RuleSetUseView,
  type RuleSetVariantView,
  type RuleSetView,
} from './pay-rules.service';
import { WorkingDaysService, type WorkingDaysYearView } from './working-days.service';

// Owners and admins change pay rules and holidays; accountants see them (AGENTS.md: Roles).
// Timekeepers and foremen never see pay settings.

/** The company's pay categories (AGENTS.md: Pay rule sets), versioned by the month they apply from. */
@ForModule('PAYROLL')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
@Controller('pay-categories')
export class PayCategoriesController {
  constructor(private readonly rules: PayRulesService) {}

  @Get()
  list(@CompanyAuth() auth: CompanyAuthContext): Promise<PayCategoriesView[]> {
    return this.rules.listPayCategories(auth.company.id);
  }

  @Put(':year/:month')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  set(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param(new ZodPipe(yearMonthSchema)) from: YearMonth,
    @Body(new ZodPipe(payCategoriesSchema)) body: PayCategories,
  ): Promise<void> {
    return this.rules.setPayCategories(auth, from, body.categoryIds);
  }

  @Delete(':year/:month')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  remove(@CompanyAuth() auth: CompanyAuthContext, @Param(new ZodPipe(yearMonthSchema)) from: YearMonth): Promise<void> {
    return this.rules.removePayCategories(auth, from);
  }
}

/** The company's rounding step of the amount to pay out (AGENTS.md: Pay model), versioned by month. */
@ForModule('PAYROLL')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
@Controller('pay-rounding')
export class PayRoundingController {
  constructor(private readonly rules: PayRulesService) {}

  @Get()
  list(@CompanyAuth() auth: CompanyAuthContext): Promise<PayRoundingView[]> {
    return this.rules.listRounding(auth.company.id);
  }

  @Put(':year/:month')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  set(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param(new ZodPipe(yearMonthSchema)) from: YearMonth,
    @Body(new ZodPipe(payRoundingSchema)) body: PayRounding,
  ): Promise<void> {
    return this.rules.setRounding(auth, from, body.step);
  }

  @Delete(':year/:month')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  remove(@CompanyAuth() auth: CompanyAuthContext, @Param(new ZodPipe(yearMonthSchema)) from: YearMonth): Promise<void> {
    return this.rules.removeRounding(auth, from);
  }
}

/** The rule set the company uses, from a month on. */
@ForModule('PAYROLL')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
@Controller('company/rule-set')
export class CompanyRuleSetController {
  constructor(private readonly rules: PayRulesService) {}

  @Get()
  list(@CompanyAuth() auth: CompanyAuthContext): Promise<RuleSetUseView[]> {
    return this.rules.listUses(auth.company.id, { company: true });
  }

  @Put(':year/:month')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  set(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param(new ZodPipe(yearMonthSchema)) from: YearMonth,
    @Body(new ZodPipe(companyRuleSetUseSchema)) body: CompanyRuleSetUse,
  ): Promise<void> {
    return this.rules.setUse(auth, { company: true }, from, body.ruleSetId);
  }

  @Delete(':year/:month')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  remove(@CompanyAuth() auth: CompanyAuthContext, @Param(new ZodPipe(yearMonthSchema)) from: YearMonth): Promise<void> {
    return this.rules.removeUse(auth, { company: true }, from);
  }
}

/**
 * Rule sets that the company, sites and firms choose (AGENTS.md: Pay rule sets), and their
 * combinations, each with its own rules and working days (the routes taking a combination's id).
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

  /** The set's combinations; each one's rules and working days go through the routes below with its own id. */
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

  @Get(':id/pay-rules')
  list(@CompanyAuth() auth: CompanyAuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<PayRulesVersionView[]> {
    return this.rules.listRules(auth.company.id, id);
  }

  @Put(':id/pay-rules/:year/:month')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  set(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param(new ZodPipe(yearMonthSchema)) from: YearMonth,
    @Body(new ZodPipe(payRulesSchema)) body: PayRules,
  ): Promise<void> {
    return this.rules.setRules(auth, id, from, body);
  }

  @Delete(':id/pay-rules/:year/:month')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  remove(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param(new ZodPipe(yearMonthSchema)) from: YearMonth,
  ): Promise<void> {
    return this.rules.removeRules(auth, id, from);
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
