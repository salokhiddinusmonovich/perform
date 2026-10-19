// Local PostgreSQL for development: PGlite (Postgres compiled to WASM) behind a
// wire-protocol socket, so Prisma connects to it like a normal server.
// No Docker, no system install, works from an admin Windows session.
// Data lives in .pgdata/ (git-ignored). Stop with Ctrl+C. DEV_DB_DEBUG=1 logs connections.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { fileURLToPath } from 'node:url';

const dataDir = fileURLToPath(new URL('../.pgdata', import.meta.url));
const port = Number(process.env.DEV_DB_PORT ?? 5432);

const db = await PGlite.create(dataDir);
const server = new PGLiteSocketServer({
  db,
  port,
  host: '127.0.0.1',
  // Several clients (API, Prisma CLI, tests) may connect at once; the server queues
  // their queries onto the single PGlite session, keeping transactions together.
  // The library's default is 1, and it never frees the slot of a client that was
  // killed (ECONNRESET goes through its "error" path, which doesn't remove the
  // handler, pglite-socket 0.2.13). With a limit of 1, one killed client locked
  // everyone out. A high limit leaves room for those leaked slots.
  maxConnections: 100,
  debug: process.env.DEV_DB_DEBUG === '1',
});
await server.start();
console.log(`PostgreSQL (PGlite) ready on 127.0.0.1:${port}, database "postgres"`);

const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
