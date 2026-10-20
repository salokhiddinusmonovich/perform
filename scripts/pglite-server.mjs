// PGlite (Postgres compiled to WASM) behind a wire-protocol socket, so Prisma connects
// to it like a normal server. Shared by the dev database (scripts/dev-db.mjs) and the
// local API tests (apps/api/test/global-setup.ts).
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

/** Starts a socket server for `db` and returns it (stop with `server.stop()`). */
export async function startPgliteServer(db, { port, host = '127.0.0.1', debug = false }) {
  followExtendedProtocolErrorRules(db);
  const server = new PGLiteSocketServer({
    db,
    port,
    host,
    // Several clients (API, Prisma CLI, tests) may connect at once; the server queues
    // their queries onto the single PGlite session, keeping transactions together.
    // The library's default is 1, and it never frees the slot of a client that was
    // killed (ECONNRESET goes through its "error" path, which doesn't remove the
    // handler, pglite-socket 0.2.13). With a limit of 1, one killed client locked
    // everyone out. A high limit leaves room for those leaked slots.
    maxConnections: 100,
    debug,
  });
  await server.start();
  return server;
}

const TYPE = (letter) => letter.charCodeAt(0);
/** Extended-protocol client messages: Parse, Bind, Describe, Execute, Close, Flush. */
const EXTENDED = new Set(['P', 'B', 'D', 'E', 'C', 'H'].map(TYPE));
const SYNC = TYPE('S');
const ERROR_RESPONSE = TYPE('E');
const READY_FOR_QUERY = TYPE('Z');

/**
 * Makes errors in the extended query protocol behave like PostgreSQL.
 *
 * The socket server hands PGlite one client message at a time. When a Parse/Bind/Execute
 * fails (e.g. a unique violation), PGlite answers ErrorResponse + ReadyForQuery right
 * away, and the client's following Sync produces a second ReadyForQuery. PostgreSQL
 * instead skips messages until Sync and sends one ReadyForQuery. The extra one puts
 * Prisma out of step: it reports "Server has closed the connection" (P1017) instead of
 * the real error (e.g. P2002), and the next query on that connection can fail too
 * (pglite 0.5.10, pglite-socket 0.2.13).
 *
 * State is per PGlite session, which all clients share anyway (see dev-db.mjs).
 */
function followExtendedProtocolErrorRules(db) {
  const execProtocolRawStream = db.execProtocolRawStream.bind(db);
  let skipUntilSync = false;

  db.execProtocolRawStream = async (message, options) => {
    const type = message[0];
    if (type === SYNC) skipUntilSync = false;
    if (!EXTENDED.has(type)) return execProtocolRawStream(message, options);
    if (skipUntilSync) return;

    // Copied: PGlite passes views into its WASM memory, which it reuses after the callback.
    const chunks = [];
    await execProtocolRawStream(message, { ...options, onRawData: (data) => chunks.push(Buffer.from(data)) });
    const replies = splitMessages(Buffer.concat(chunks));
    if (replies.some((reply) => reply[0] === ERROR_RESPONSE)) {
      skipUntilSync = true;
      const kept = replies.filter((reply) => reply[0] !== READY_FOR_QUERY);
      if (kept.length) options.onRawData(new Uint8Array(Buffer.concat(kept)));
    } else if (chunks.length) {
      for (const chunk of chunks) options.onRawData(chunk);
    }
  };
}

/** Splits server output into whole messages (1 type byte + 4-byte length incl. itself). */
function splitMessages(data) {
  const messages = [];
  for (let at = 0; at + 5 <= data.length; ) {
    const end = at + 1 + data.readUInt32BE(at + 1);
    messages.push(data.subarray(at, end));
    at = end;
  }
  return messages;
}
