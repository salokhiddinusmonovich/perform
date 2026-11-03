import { Module } from '@nestjs/common';
import { PayRulesModule } from '../pay-rules/pay-rules.module';
import { AdjustmentsService } from './adjustments.service';
import { MonthlyHoursService } from './monthly-hours.service';
import { AdjustmentsController, MonthlyHoursController, PayrollController, TravelAmountsController } from './payroll.controller';
import { PayrollService } from './payroll.service';
import { TravelAmountsService } from './travel-amounts.service';

/** Monthly hours, travel amounts, adjustments and the payroll run. */
@Module({
  imports: [PayRulesModule],
  controllers: [MonthlyHoursController, TravelAmountsController, AdjustmentsController, PayrollController],
  providers: [MonthlyHoursService, TravelAmountsService, AdjustmentsService, PayrollService],
})
export class PayrollModule {}
