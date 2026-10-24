import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CompanyModule } from './company/company.module';
import { HealthModule } from './health/health.module';
import { InvitationsModule } from './invitations/invitations.module';
import { OrganisationModule } from './organisation/organisation.module';
import { PayRulesModule } from './pay-rules/pay-rules.module';
import { PayrollModule } from './payroll/payroll.module';
import { PlatformModule } from './platform/platform.module';
import { PrismaModule } from './prisma/prisma.module';
import { TimesheetModule } from './timesheet/timesheet.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuditModule,
    AuthModule,
    HealthModule,
    CompanyModule,
    InvitationsModule,
    PlatformModule,
    PayRulesModule,
    OrganisationModule,
    PayrollModule,
    TimesheetModule,
  ],
})
export class AppModule {}
