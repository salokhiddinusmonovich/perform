import { Module } from '@nestjs/common';
import {
  DepartmentsController,
  ShiftsController,
  SitesController,
  TeamsController,
  WorkerShiftsController,
  WorkersController,
} from './organisation.controller';
import { DepartmentsService } from './departments.service';
import { ShiftsService } from './shifts.service';
import { SitesService } from './sites.service';
import { WorkersService } from './workers.service';

/** Sites, teams, departments, workers and their shifts, and which members work where. */
@Module({
  controllers: [
    SitesController,
    TeamsController,
    WorkersController,
    ShiftsController,
    WorkerShiftsController,
    DepartmentsController,
  ],
  providers: [SitesService, WorkersService, ShiftsService, DepartmentsService],
})
export class OrganisationModule {}
