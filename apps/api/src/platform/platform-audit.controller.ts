import { Controller, Get, Query } from '@nestjs/common';
import { auditQuerySchema, type AuditQuery } from '@puantaj/schemas';
import { PlatformAdminOnly } from '../auth/auth.context';
import { ZodPipe } from '../common/zod.pipe';
import { PlatformAuditService, type AuditPage } from './platform-audit.service';

@PlatformAdminOnly()
@Controller('platform/audit')
export class PlatformAuditController {
  constructor(private readonly audit: PlatformAuditService) {}

  @Get()
  list(@Query(new ZodPipe(auditQuerySchema)) query: AuditQuery): Promise<AuditPage> {
    return this.audit.list(query);
  }
}
