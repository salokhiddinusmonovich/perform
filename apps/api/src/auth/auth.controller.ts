import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  changePasswordSchema,
  loginSchema,
  switchCompanySchema,
  type ChangePasswordInput,
  type LoginInput,
} from '@puantaj/schemas';
import type { Request, Response } from 'express';
import { ZodPipe } from '../common/zod.pipe';
import {
  AllowTemporaryPassword,
  Auth,
  MaybeAuth,
  OptionalAuth,
  Public,
  type AuthContext,
} from './auth.context';
import { AuthService, type Me } from './auth.service';
import { SESSION_COOKIE, sessionCookieOptions } from './session.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(204)
  async login(
    @Body(new ZodPipe(loginSchema)) body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = await this.auth.login(body, req.ip ?? '', req.get('user-agent'));
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
  }

  @AllowTemporaryPassword()
  @Post('logout')
  @HttpCode(204)
  async logout(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(auth);
    res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
  }

  /** null when not logged in: not an error, so anonymous visitors see no 401s. */
  @OptionalAuth()
  @AllowTemporaryPassword()
  @Get('me')
  async me(@MaybeAuth() auth: AuthContext | null): Promise<Me | null> {
    return auth ? this.auth.me(auth) : null;
  }

  @AllowTemporaryPassword()
  @Post('change-password')
  @HttpCode(204)
  changePassword(
    @Auth() auth: AuthContext,
    @Body(new ZodPipe(changePasswordSchema)) body: ChangePasswordInput,
  ): Promise<void> {
    return this.auth.changePassword(auth, body);
  }

  @Post('switch-company')
  @HttpCode(204)
  switchCompany(
    @Auth() auth: AuthContext,
    @Body(new ZodPipe(switchCompanySchema)) body: { companyId: string },
  ): Promise<void> {
    return this.auth.switchCompany(auth, body.companyId);
  }
}
