/**
 * Provides a migrated, empty database for the API tests.
 * - CI sets TEST_DATABASE_URL to a real PostgreSQL service.
 * - Locally, an in-memory PGlite server is started on a free port (dev data is untouched).
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function migrate(databaseUrl: string): Promise<void> {
  // Async on purpose: the PGlite server runs in this process and must keep serving.
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`prisma migrate deploy failed:\n${output}`))));
  });
}

export default async function setup(project: TestProject) {
  let databaseUrl = process.env.TEST_DATABASE_URL;
  let stop: (() => Promise<void>) | undefined;

  if (!databaseUrl) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
    const port = await freePort();
    const db = await PGlite.create();
    const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 100 });
    await server.start();
    databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?pgbouncer=true&connection_limit=1&sslmode=disable`;
    stop = async () => {
      await server.stop();
      await db.close();
    };
  }

  await migrate(databaseUrl);
  project.provide('databaseUrl', databaseUrl);
  return stop;
}
