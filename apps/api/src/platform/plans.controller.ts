import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { planSchema, updatePlanSchema, type Plan, type UpdatePlan } from '@puantaj/schemas';
import { Auth, PlatformAdminOnly, type AuthContext } from '../auth/auth.context';
import { ZodPipe } from '../common/zod.pipe';
import { PlansService, type PlanView } from './plans.service';

@PlatformAdminOnly()
@Controller('platform/plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  list(): Promise<PlanView[]> {
    return this.plans.list();
  }

  @Post()
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(planSchema)) body: Plan): Promise<{ id: string }> {
    return this.plans.create(auth, body);
  }

  @Patch(':id')
  @HttpCode(204)
  update(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updatePlanSchema)) body: UpdatePlan,
  ): Promise<void> {
    return this.plans.update(auth, id, body);
  }
}
