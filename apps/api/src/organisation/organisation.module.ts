import { Module } from '@nestjs/common';
import {
  ShiftsController,
  SitesController,
  TeamsController,
  WorkerShiftsController,
  WorkersController,
} from './organisation.controller';
import { ShiftsService } from './shifts.service';
import { SitesService } from './sites.service';
import { WorkersService } from './workers.service';

/** Sites, teams, workers and their shifts, and which members work where. */
@Module({
  controllers: [SitesController, TeamsController, WorkersController, ShiftsController, WorkerShiftsController],
  providers: [SitesService, WorkersService, ShiftsService],
})
export class OrganisationModule {}
