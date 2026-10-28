import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import {
  createWorkerSchema,
  departmentSchema,
  departmentSettingsSchema,
  leaveSchema,
  placementDepartmentSchema,
  placementSchema,
  salarySchema,
  shiftSchema,
  siteSchema,
  staffSchema,
  teamSchema,
  updateDepartmentSchema,
  updateSiteSchema,
  updateShiftSchema,
  updateTeamSchema,
  workerSchema,
  workerShiftSchema,
  workerShiftsSchema,
  type CreateWorker,
  type Department,
  type DepartmentSettings,
  type Leave,
  type Placement,
  type PlacementDepartment,
  type Salary,
  type Shift,
  type Site,
  type Team,
  type UpdateDepartment,
  type UpdateSite,
  type UpdateShift,
  type UpdateTeam,
  type Worker,
  type WorkerShift,
  type WorkerShifts,
} from '@puantaj/schemas';
import { CompanyAuth, ForModule, Roles, type CompanyAuthContext } from '../auth/auth.context';
import { ZodPipe } from '../common/zod.pipe';
import { DepartmentsService, type DepartmentView } from './departments.service';
import { ShiftsService, type ShiftView, type WorkerShiftView } from './shifts.service';
import { SitesService, type SiteView, type StaffView } from './sites.service';
import { WorkersService, type SalaryView, type WorkerView } from './workers.service';

// Everyone in the company sees sites, teams and workers within their scope (access.ts).
// Changing them is narrower; the services also check the caller's sites.

/** Sites with their teams and staff. Owners and admins create and change sites. */
@ForModule('PAYROLL')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'PROJECT_MANAGER', 'TIMEKEEPER', 'FOREMAN')
@Controller('sites')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Get()
  list(@CompanyAuth() auth: CompanyAuthContext): Promise<SiteView[]> {
    return this.sites.list(auth);
  }

  /** People who can be assigned to sites and teams (for the assign pickers). */
  @Get('staff-candidates')
  @Roles('OWNER', 'ADMIN', 'PROJECT_MANAGER')
  staffCandidates(@CompanyAuth() auth: CompanyAuthContext): Promise<StaffView[]> {
    return this.sites.staffCandidates(auth);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  create(@CompanyAuth() auth: CompanyAuthContext, @Body(new ZodPipe(siteSchema)) body: Site) {
    return this.sites.createSite(auth, body);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  update(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateSiteSchema)) body: UpdateSite,
  ): Promise<void> {
    return this.sites.updateSite(auth, id, body);
  }

  /** Assign a project manager (owners, admins) or timekeeper (also the site's project manager). */
  @Post(':id/staff')
  @Roles('OWNER', 'ADMIN', 'PROJECT_MANAGER')
  @HttpCode(204)
  addStaff(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(staffSchema)) body: { userId: string },
  ): Promise<void> {
    return this.sites.addSiteStaff(auth, id, body.userId);
  }

  @Delete(':id/staff/:userId')
  @Roles('OWNER', 'ADMIN', 'PROJECT_MANAGER')
  @HttpCode(204)
  removeStaff(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    return this.sites.removeSiteStaff(auth, id, userId);
  }
}

/** Teams on a site and their foremen. Owners, admins and the site's project manager manage them. */
@ForModule('PAYROLL')
@Roles('OWNER', 'ADMIN', 'PROJECT_MANAGER')
@Controller('teams')
export class TeamsController {
  constructor(private readonly sites: SitesService) {}

  @Post()
  create(@CompanyAuth() auth: CompanyAuthContext, @Body(new ZodPipe(teamSchema)) body: Team) {
    return this.sites.createTeam(auth, body);
  }

  @Patch(':id')
  @HttpCode(204)
  update(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateTeamSchema)) body: UpdateTeam,
  ): Promise<void> {
    return this.sites.updateTeam(auth, id, body);
  }

  @Post(':id/foremen')
  @HttpCode(204)
  addForeman(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(staffSchema)) body: { userId: string },
  ): Promise<void> {
    return this.sites.addForeman(auth, id, body.userId);
  }

  @Delete(':id/foremen/:userId')
  @HttpCode(204)
  removeForeman(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    return this.sites.removeForeman(auth, id, userId);
  }
}

/** Workers and their placements. Owners, admins and project managers (own sites) change them. */
@ForModule('PAYROLL')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'PROJECT_MANAGER', 'TIMEKEEPER', 'FOREMAN')
@Controller('workers')
export class WorkersController {
  constructor(
    private readonly workers: WorkersService,
    private readonly shifts: ShiftsService,
  ) {}

  @Get()
  list(@CompanyAuth() auth: CompanyAuthContext): Promise<WorkerView[]> {
    return this.workers.list(auth);
  }

  @Get(':id')
  get(@CompanyAuth() auth: CompanyAuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<WorkerView> {
    return this.workers.get(auth, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'PROJECT_MANAGER')
  create(@CompanyAuth() auth: CompanyAuthContext, @Body(new ZodPipe(createWorkerSchema)) body: CreateWorker) {
    return this.workers.create(auth, body);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'PROJECT_MANAGER')
  @HttpCode(204)
  update(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(workerSchema)) body: Worker,
  ): Promise<void> {
    return this.workers.update(auth, id, body);
  }

  /** Move to another site or team from a day, or come back after leaving. */
  @Post(':id/placements')
  @Roles('OWNER', 'ADMIN', 'PROJECT_MANAGER')
  @HttpCode(204)
  place(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(placementSchema)) body: Placement,
  ): Promise<void> {
    return this.workers.place(auth, id, body);
  }

  /**
   * Fills in the department of a placement that has none, e.g. from before the company used
   * departments. A department set once is changed only by a new placement from a day.
   */
  @Put(':id/placements/:placementId/department')
  @Roles('OWNER', 'ADMIN', 'PROJECT_MANAGER')
  @HttpCode(204)
  placementDepartment(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('placementId', ParseUUIDPipe) placementId: string,
    @Body(new ZodPipe(placementDepartmentSchema)) body: PlacementDepartment,
  ): Promise<void> {
    return this.workers.fillDepartment(auth, id, placementId, body.departmentId);
  }

  /** Salary history. Timekeepers and foremen never see salaries. */
  @Get(':id/salaries')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'PROJECT_MANAGER')
  salaries(@CompanyAuth() auth: CompanyAuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<SalaryView[]> {
    return this.workers.salaries(auth, id);
  }

  /** Salaries are only ever added (a raise or a correction is a new one); project managers only view them. */
  @Post(':id/salaries')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  addSalary(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(salarySchema)) body: Salary,
  ): Promise<{ id: string }> {
    return this.workers.addSalary(auth, id, body);
  }

  /** The worker's shifts, oldest first. A shift carries no pay amounts, so everyone who sees the worker sees them. */
  @Get(':id/shifts')
  workerShifts(@CompanyAuth() auth: CompanyAuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<WorkerShiftView[]> {
    return this.shifts.forWorker(auth, id);
  }

  /** Corrects a shift row: owners and admins only (others add a newer one). */
  @Put(':id/shifts/:rowId')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  correctShift(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Body(new ZodPipe(workerShiftSchema)) body: WorkerShift,
  ): Promise<void> {
    return this.shifts.correct(auth, id, rowId, body);
  }

  @Delete(':id/shifts/:rowId')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  removeShift(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
  ): Promise<void> {
    return this.shifts.remove(auth, id, rowId);
  }

  @Post(':id/leave')
  @Roles('OWNER', 'ADMIN', 'PROJECT_MANAGER')
  @HttpCode(204)
  leave(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(leaveSchema)) body: Leave,
  ): Promise<void> {
    return this.workers.leave(auth, id, body.date);
  }
}

/**
 * The company's shifts (AGENTS.md: Shifts). Everyone sees them; owners and admins define
 * them.
 */
@ForModule('PAYROLL')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'PROJECT_MANAGER', 'TIMEKEEPER', 'FOREMAN')
@Controller('shifts')
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Get()
  list(@CompanyAuth() auth: CompanyAuthContext): Promise<ShiftView[]> {
    return this.shifts.list(auth);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  create(@CompanyAuth() auth: CompanyAuthContext, @Body(new ZodPipe(shiftSchema)) body: Shift): Promise<{ id: string }> {
    return this.shifts.create(auth, body);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  update(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateShiftSchema)) body: UpdateShift,
  ): Promise<void> {
    return this.shifts.update(auth, id, body);
  }
}

/**
 * The company's departments (AGENTS.md: Departments). Everyone sees them; owners and admins
 * manage them and switch them on or off.
 */
@ForModule('PAYROLL')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'PROJECT_MANAGER', 'TIMEKEEPER', 'FOREMAN')
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Get()
  list(@CompanyAuth() auth: CompanyAuthContext): Promise<DepartmentView[]> {
    return this.departments.list(auth);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  create(
    @CompanyAuth() auth: CompanyAuthContext,
    @Body(new ZodPipe(departmentSchema)) body: Department,
  ): Promise<{ id: string }> {
    return this.departments.create(auth, body);
  }

  @Put('settings')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  settings(
    @CompanyAuth() auth: CompanyAuthContext,
    @Body(new ZodPipe(departmentSettingsSchema)) body: DepartmentSettings,
  ): Promise<void> {
    return this.departments.setEnabled(auth, body.enabled);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  @HttpCode(204)
  update(
    @CompanyAuth() auth: CompanyAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateDepartmentSchema)) body: UpdateDepartment,
  ): Promise<void> {
    return this.departments.update(auth, id, body);
  }
}

/**
 * Giving workers a shift from a day, one or many at once: owners, admins and accountants
 * for every worker, timekeepers for workers placed on their sites (access.ts).
 */
@ForModule('PAYROLL')
@Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'TIMEKEEPER')
@Controller('worker-shifts')
export class WorkerShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Post()
  assign(
    @CompanyAuth() auth: CompanyAuthContext,
    @Body(new ZodPipe(workerShiftsSchema)) body: WorkerShifts,
  ): Promise<{ added: number; unchanged: number }> {
    return this.shifts.assign(auth, body);
  }
}
