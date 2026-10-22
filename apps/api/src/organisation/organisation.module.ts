import { Module } from '@nestjs/common';
import { SitesController, TeamsController, WorkersController } from './organisation.controller';
import { SitesService } from './sites.service';
import { WorkersService } from './workers.service';

/** Sites, teams, workers, and which members work where. */
@Module({
  controllers: [SitesController, TeamsController, WorkersController],
  providers: [SitesService, WorkersService],
})
export class OrganisationModule {}
