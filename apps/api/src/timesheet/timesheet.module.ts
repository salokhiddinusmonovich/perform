import { Module } from '@nestjs/common';
import { PayRulesModule } from '../pay-rules/pay-rules.module';
import { TimesheetController, TimesheetSettingsController } from './timesheet.controller';
import { TimesheetSettingsService } from './timesheet-settings.service';
import { TimesheetService } from './timesheet.service';

/** Daily hour entry and its settings (the Timesheet module). */
@Module({
  imports: [PayRulesModule],
  controllers: [TimesheetSettingsController, TimesheetController],
  providers: [TimesheetSettingsService, TimesheetService],
})
export class TimesheetModule {}
