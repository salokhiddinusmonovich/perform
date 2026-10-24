import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import {
  entryVersionQuerySchema,
  timesheetEntrySchema,
  timesheetQuerySchema,
  timesheetSettingsSchema,
  yearMonthSchema,
  type EntryVersionQuery,
  type TimesheetEntry,
  type TimesheetQuery,
  type TimesheetSettings,
  type YearMonth,
} from '@puantaj/schemas';
import { CompanyAuth, ForModule, Roles, type CompanyAuthContext } from '../auth/auth.context';
import { ZodPipe } from '../common/zod.pipe';
import { TimesheetSettingsService, type TimesheetSettingsView } from './timesheet-settings.service';
import { TimesheetService, type TimesheetEntryView, type TimesheetMonthView } from './timesheet.service';

/** Who enters daily hours. Owners and admins see and change it. */
@ForModule('TIMESHEET')
@Roles('OWNER', 'ADMIN')
@Controller('timesheet/settings')
export class TimesheetSettingsController {
  constructor(private readonly settings: TimesheetSettingsService) {}

  @Get()
  get(@CompanyAuth() auth: CompanyAuthContext): Promise<TimesheetSettingsView> {
    return this.settings.get(auth);
  }

  @Put()
  @HttpCode(204)
  set(
    @CompanyAuth() auth: CompanyAuthContext,
    @Body(new ZodPipe(timesheetSettingsSchema)) body: TimesheetSettings,
  ): Promise<void> {
    return this.settings.set(auth, body);
  }
}

/**
 * Daily hours. Everyone sees them within their scope (access.ts). Owners and admins
 * enter them anywhere; timekeepers and foremen when Settings let them, on their own
 * sites or teams. Project managers and accountants only look.
 */
@ForModule('TIMESHEET')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'PROJECT_MANAGER', 'TIMEKEEPER', 'FOREMAN')
@Controller('timesheet')
export class TimesheetController {
  constructor(private readonly timesheet: TimesheetService) {}

  @Get(':year/:month')
  month(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param(new ZodPipe(yearMonthSchema)) month: YearMonth,
    @Query(new ZodPipe(timesheetQuerySchema)) query: TimesheetQuery,
  ): Promise<TimesheetMonthView> {
    return this.timesheet.month(auth, month, query.siteId);
  }

  /** Creates or changes the entry with this client-made id; a retry changes nothing. */
  @Put('entries/:id')
  @Roles('OWNER', 'ADMIN', 'TIMEKEEPER', 'FOREMAN')
  write(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(timesheetEntrySchema)) body: TimesheetEntry,
  ): Promise<TimesheetEntryView> {
    return this.timesheet.write(auth, id, body);
  }

  @Delete('entries/:id')
  @Roles('OWNER', 'ADMIN', 'TIMEKEEPER', 'FOREMAN')
  @HttpCode(204)
  remove(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(entryVersionQuerySchema)) query: EntryVersionQuery,
  ): Promise<void> {
    return this.timesheet.remove(auth, id, query.version);
  }
}
