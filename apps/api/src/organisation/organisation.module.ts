import { Module } from '@nestjs/common';
import {
  DepartmentsController,
  FirmsController,
  PositionsController,
  ShiftsController,
  SitesController,
  TeamsController,
  TravelRoutesController,
  WorkerCategoriesController,
  WorkerShiftsController,
  WorkersController,
} from './organisation.controller';
import { DepartmentsService } from './departments.service';
import { FirmsService } from './firms.service';
import { PositionsService } from './positions.service';
import { ShiftsService } from './shifts.service';
import { SitesService } from './sites.service';
import { TravelRoutesService } from './travel-routes.service';
import { WorkerCategoriesService } from './worker-categories.service';
import { WorkersService } from './workers.service';

/** Sites, teams, departments, firms, worker categories, workers with their shifts and positions, travel routes, and which members work where. */
@Module({
  controllers: [
    SitesController,
    TeamsController,
    WorkersController,
    ShiftsController,
    WorkerShiftsController,
    PositionsController,
    DepartmentsController,
    FirmsController,
    WorkerCategoriesController,
    TravelRoutesController,
  ],
  providers: [SitesService, WorkersService, ShiftsService, PositionsService, DepartmentsService, FirmsService, WorkerCategoriesService, TravelRoutesService],
  exports: [WorkersService, PositionsService],
})
export class OrganisationModule {}
