import { Module } from '@nestjs/common';
import { PayRulesModule } from '../pay-rules/pay-rules.module';
import { TimesheetCodesService } from './timesheet-codes.service';
import { TimesheetCodesController, TimesheetController, TimesheetSettingsController } from './timesheet.controller';
import { TimesheetSettingsService } from './timesheet-settings.service';
import { TimesheetService } from './timesheet.service';

/** Daily hour entry and its settings (the Timesheet module), and the company's own codes. */
@Module({
  imports: [PayRulesModule],
  controllers: [TimesheetSettingsController, TimesheetCodesController, TimesheetController],
  providers: [TimesheetCodesService, TimesheetSettingsService, TimesheetService],
})
export class TimesheetModule {}
