import { Module } from '@nestjs/common';
import { PayRulesModule } from '../pay-rules/pay-rules.module';
import { MonthlyHoursService } from './monthly-hours.service';
import { MonthlyHoursController, PayrollController } from './payroll.controller';
import { PayrollService } from './payroll.service';

/** Monthly hours and the payroll run. */
@Module({
  imports: [PayRulesModule],
  controllers: [MonthlyHoursController, PayrollController],
  providers: [MonthlyHoursService, PayrollService],
})
export class PayrollModule {}
