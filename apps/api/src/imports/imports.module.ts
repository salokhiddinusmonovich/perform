import { Module } from '@nestjs/common';
import { OrganisationModule } from '../organisation/organisation.module';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

/** Excel import of a month's sheet: new workers, then the daily hours. */
@Module({
  imports: [OrganisationModule],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
