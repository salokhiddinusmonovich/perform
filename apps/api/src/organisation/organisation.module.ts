import { Module } from '@nestjs/common';
import {
  DepartmentsController,
  FirmsController,
  ShiftsController,
  SitesController,
  TeamsController,
  WorkerShiftsController,
  WorkersController,
} from './organisation.controller';
import { DepartmentsService } from './departments.service';
import { FirmsService } from './firms.service';
import { ShiftsService } from './shifts.service';
import { SitesService } from './sites.service';
import { WorkersService } from './workers.service';

/** Sites, teams, departments, firms, workers and their shifts, and which members work where. */
@Module({
  controllers: [
    SitesController,
    TeamsController,
    WorkersController,
    ShiftsController,
    WorkerShiftsController,
    DepartmentsController,
    FirmsController,
  ],
  providers: [SitesService, WorkersService, ShiftsService, DepartmentsService, FirmsService],
  exports: [WorkersService],
})
export class OrganisationModule {}
