import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import {
  appLoginSchema,
  changePasswordSchema,
  loginSchema,
  switchCompanySchema,
  type AppLoginInput,
  type ChangePasswordInput,
  type LoginInput,
} from '@puantaj/schemas';
import type { Request, Response } from 'express';
import { ZodPipe } from '../common/zod.pipe';
import {
  AllowTemporaryPassword,
  Auth,
  MaybeAuth,
  NotWhileImpersonating,
  OptionalAuth,
  Public,
  type AuthContext,
} from './auth.context';
import { AuthService, type Me, type SessionView } from './auth.service';
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
    const token = await this.auth.login(body, { kind: 'BROWSER', ip: req.ip ?? '', userAgent: req.get('user-agent') });
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
  }

  /**
   * The mobile app's login. Returns the token once; the app sends it as
   * `Authorization: Bearer <token>` and the server keeps only its hash.
   */
  @Public()
  @Post('token')
  async token(@Body(new ZodPipe(appLoginSchema)) body: AppLoginInput, @Req() req: Request): Promise<{ token: string }> {
    const { deviceName, ...login } = body;
    const token = await this.auth.login(login, {
      kind: 'APP',
      deviceName,
      ip: req.ip ?? '',
      userAgent: req.get('user-agent'),
    });
    return { token };
  }

  @AllowTemporaryPassword()
  @NotWhileImpersonating()
  @Get('sessions')
  sessions(@Auth() auth: AuthContext): Promise<SessionView[]> {
    return this.auth.listSessions(auth);
  }

  @AllowTemporaryPassword()
  @NotWhileImpersonating()
  @Delete('sessions/:id')
  @HttpCode(204)
  revokeSession(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.auth.revokeSession(auth, id);
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
  @NotWhileImpersonating()
  @Post('change-password')
  @HttpCode(204)
  changePassword(
    @Auth() auth: AuthContext,
    @Body(new ZodPipe(changePasswordSchema)) body: ChangePasswordInput,
  ): Promise<void> {
    return this.auth.changePassword(auth, body);
  }

  /** A platform admin stops acting as a user and is themselves again. */
  @Post('impersonation/end')
  @HttpCode(204)
  endImpersonation(@Auth() auth: AuthContext): Promise<void> {
    return this.auth.endImpersonation(auth);
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
