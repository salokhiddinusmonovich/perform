import { Module } from '@nestjs/common';
import { PayRulesModule } from '../pay-rules/pay-rules.module';
import { AdjustmentsService } from './adjustments.service';
import { MonthlyHoursService } from './monthly-hours.service';
import { AdjustmentsController, MonthlyHoursController, PayrollController } from './payroll.controller';
import { PayrollService } from './payroll.service';

/** Monthly hours, adjustments and the payroll run. */
@Module({
  imports: [PayRulesModule],
  controllers: [MonthlyHoursController, AdjustmentsController, PayrollController],
  providers: [MonthlyHoursService, AdjustmentsService, PayrollService],
})
export class PayrollModule {}
