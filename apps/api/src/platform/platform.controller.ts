import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { createCompanySchema, type CreateCompany } from '@puantaj/schemas';
import { z } from 'zod';
import { Auth, PlatformAdminOnly, type AuthContext } from '../auth/auth.context';
import { ZodPipe } from '../common/zod.pipe';
import { PlatformService, type CompanyListItem } from './platform.service';

const setActiveSchema = z.object({ isActive: z.boolean() });

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
  setActive(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(setActiveSchema)) body: { isActive: boolean },
  ): Promise<void> {
    return this.platform.setActive(auth, id, body.isActive);
  }
}
