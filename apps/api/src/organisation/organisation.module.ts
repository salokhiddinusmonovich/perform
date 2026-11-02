import { Module } from '@nestjs/common';
import {
  DepartmentsController,
  FirmsController,
  ShiftsController,
  SitesController,
  TeamsController,
  WorkerCategoriesController,
  WorkerShiftsController,
  WorkersController,
} from './organisation.controller';
import { DepartmentsService } from './departments.service';
import { FirmsService } from './firms.service';
import { ShiftsService } from './shifts.service';
import { SitesService } from './sites.service';
import { WorkerCategoriesService } from './worker-categories.service';
import { WorkersService } from './workers.service';

/** Sites, teams, departments, firms, worker categories, workers and their shifts, and which members work where. */
@Module({
  controllers: [
    SitesController,
    TeamsController,
    WorkersController,
    ShiftsController,
    WorkerShiftsController,
    DepartmentsController,
    FirmsController,
    WorkerCategoriesController,
  ],
  providers: [SitesService, WorkersService, ShiftsService, DepartmentsService, FirmsService, WorkerCategoriesService],
  exports: [WorkersService],
})
export class OrganisationModule {}
