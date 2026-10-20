// Local PostgreSQL for development: PGlite behind a wire-protocol socket
// (scripts/pglite-server.mjs). No Docker, no system install, works from an admin
// Windows session.
// Data lives in .pgdata/ (git-ignored). Stop with Ctrl+C. DEV_DB_DEBUG=1 logs connections.
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { startPgliteServer } from './pglite-server.mjs';

const dataDir = fileURLToPath(new URL('../.pgdata', import.meta.url));
const port = Number(process.env.DEV_DB_PORT ?? 5432);

const db = await PGlite.create(dataDir);
const server = await startPgliteServer(db, { port, debug: process.env.DEV_DB_DEBUG === '1' });
console.log(`PostgreSQL (PGlite) ready on 127.0.0.1:${port}, database "postgres"`);

const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
