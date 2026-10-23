import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  createWorkerSchema,
  leaveSchema,
  placementSchema,
  salarySchema,
  siteSchema,
  staffSchema,
  teamSchema,
  updateSiteSchema,
  updateTeamSchema,
  workerSchema,
  type CreateWorker,
  type Leave,
  type Placement,
  type Salary,
  type Site,
  type Team,
  type UpdateSite,
  type UpdateTeam,
  type Worker,
} from '@puantaj/schemas';
import { CompanyAuth, ForModule, Roles, type CompanyAuthContext } from '../auth/auth.context';
import { ZodPipe } from '../common/zod.pipe';
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
  constructor(private readonly workers: WorkersService) {}

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
