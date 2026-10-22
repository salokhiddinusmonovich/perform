import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { forbidden } from '../common/api-error';
import { bearerToken } from './session.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Blocks cross-site request forgery: a request that changes data must come from our
 * own pages. Browsers send Origin (and Sec-Fetch-Site) on such requests; together
 * with the SameSite=Lax session cookie this stops other sites from acting as the user.
 * Requests without these headers (curl, server-to-server) carry no browser cookies
 * by accident, so they are let through to normal authentication.
 * The check is for cookie requests only: a bearer token (the mobile app) is never sent
 * by a browser on its own, and such a request is authenticated by the token alone.
 */
@Injectable()
export class SameOriginGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method) || bearerToken(req)) return true;

    if (req.get('sec-fetch-site') === 'cross-site') throw forbidden('auth.crossSite');

    const origin = req.get('origin');
    if (origin) {
      let originHost: string;
      try {
        originHost = new URL(origin).host;
      } catch {
        throw forbidden('auth.crossSite');
      }
      if (originHost !== req.get('host')) throw forbidden('auth.crossSite');
    }
    return true;
  }
}
