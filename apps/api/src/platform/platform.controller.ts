import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  createCompanySchema,
  updatePlatformCompanySchema,
  type CreateCompany,
  type UpdatePlatformCompany,
} from '@puantaj/schemas';
import { Auth, PlatformAdminOnly, type AuthContext } from '../auth/auth.context';
import { ZodPipe } from '../common/zod.pipe';
import { PlatformService, type CompanyListItem } from './platform.service';

@PlatformAdminOnly()
@Controller('platform/companies')
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get()
  list(): Promise<CompanyListItem[]> {
    return this.platform.list();
  }

  @Post()
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(createCompanySchema)) body: CreateCompany) {
    return this.platform.create(auth, body);
  }

  @Patch(':id')
  @HttpCode(204)
  update(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updatePlatformCompanySchema)) body: UpdatePlatformCompany,
  ): Promise<void> {
    return this.platform.update(auth, id, body);
  }
}
