import { Module } from '@nestjs/common';
import { HolidaysController, PayRulesController, WorkingDaysController } from './pay-rules.controller';
import { HolidaysService } from './holidays.service';
import { PayRulesService } from './pay-rules.service';
import { WorkingDaysService } from './working-days.service';

/** Pay rules, holidays and working days (Settings). */
@Module({
  controllers: [PayRulesController, HolidaysController, WorkingDaysController],
  providers: [PayRulesService, HolidaysService, WorkingDaysService],
  exports: [PayRulesService],
})
export class PayRulesModule {}
