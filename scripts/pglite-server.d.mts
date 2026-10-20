import type { PGlite } from '@electric-sql/pglite';
import type { PGLiteSocketServer } from '@electric-sql/pglite-socket';

export function startPgliteServer(
  db: PGlite,
  options: { port: number; host?: string; debug?: boolean },
): Promise<PGLiteSocketServer>;
