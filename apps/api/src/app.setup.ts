import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';

/** Shared by main.ts and the API tests, so tests run the app exactly as deployed. */
export function configureApp(app: INestApplication) {
  const express = app as NestExpressApplication;
  // Requests arrive through nginx (host) → nginx (web container). Trust only those
  // local hops when reading the client IP from X-Forwarded-For.
  express.set('trust proxy', 'loopback, uniquelocal');
  express.disable('x-powered-by');
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  return app;
}
