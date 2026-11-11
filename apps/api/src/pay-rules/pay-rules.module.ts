import { Module } from '@nestjs/common';
import {
  CompanyRuleSetController,
  FirmRuleSetController,
  HolidaysController,
  PayCategoriesController,
  PayRoundingController,
  RuleSetsController,
  SiteRuleSetController,
} from './pay-rules.controller';
import { HolidaysService } from './holidays.service';
import { PayRulesService } from './pay-rules.service';
import { WorkingDaysService } from './working-days.service';

/** Pay rules, holidays and working days (Settings). */
@Module({
  controllers: [
    PayCategoriesController,
    PayRoundingController,
    CompanyRuleSetController,
    RuleSetsController,
    SiteRuleSetController,
    FirmRuleSetController,
    HolidaysController,
  ],
  providers: [PayRulesService, HolidaysService, WorkingDaysService],
  exports: [PayRulesService],
})
export class PayRulesModule {}
