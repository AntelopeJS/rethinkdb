import type {
  Probe,
  ProbeAnswer,
  ProbeConfig,
  ProbeUnreadable,
} from "@antelopejs/interface-database-catalog";
import {
  type Connection,
  isRethinkDBError,
  r,
  RethinkDBErrorType,
} from "rethinkdb-ts";

import { ParseUrl } from "./config";
import { TableInfoOf, Writes } from "./implementations/catalog/discovery";

interface TableAccess {
  readable: boolean;
  writable: boolean;
}

/** What a signed-in answer says the account may do. */
interface Rights {
  canRead: boolean;
  canWrite: boolean;
  unreadable?: ProbeUnreadable;
}

function Unreadable(unreadable: ProbeUnreadable): Rights {
  return { canRead: false, canWrite: false, unreadable };
}

/**
 * What the probe holds while it runs: `closer` closes the connection on a late answer and once the
 * probe has settled, `closes` aborts with it or with the caller's signal and closes the socket.
 */
interface Session {
  closer: AbortController;
  closes: AbortSignal;
  timeoutMs: number;
}

const MS_PER_SECOND = 1000;
const TABLES_AT_ONCE = 32;
const DONE = "the probe has answered";
const DROPPED =
  "the server closed the connection before it answered every table check";
const ABORTED: ProbeAnswer = {
  outcome: "unreachable",
  message: "The probe was aborted.",
};
const MISSING = "does not exist";
const DRIVER_ERROR = "ReqlDriverError";

/**
 * Runs `work` and closes the connection when no answer comes within `timeoutMs`. A work whose
 * connection closed meanwhile throws why, even when it swallowed the error of a closed query.
 */
async function Within<T>(session: Session, work: () => Promise<T>): Promise<T> {
  const { closer, timeoutMs } = session;
  const timer = setTimeout(
    () =>
      closer.abort(
        new Error(`the server did not answer within ${timeoutMs} ms`),
      ),
    timeoutMs,
  );
  try {
    const answer = await work();
    closer.signal.throwIfAborted();
    return answer;
  } finally {
    clearTimeout(timer);
  }
}

/** What `proven` leaves open of the table's access, from the catalog's checks. */
async function AccessOf(
  connection: Connection,
  database: string,
  name: string,
  proven: TableAccess,
): Promise<TableAccess> {
  const table = r.db(database).table(name);
  const [readable, writable] = await Promise.all([
    proven.readable ||
      TableInfoOf(table, connection).then(
        () => true,
        () => false,
      ),
    proven.writable ||
      Writes(table, connection).then(
        (writes) => writes.insert || writes.update || writes.delete,
      ),
  ]);
  return { readable, writable };
}

/**
 * Whether the account reads any table and writes any table, 32 tables at a time, until one table
 * has proven each. The catalog's checks read any error as a refusal, so a batch the server closed
 * the connection on throws, rather than answering no access.
 */
async function AccessOfTables(
  session: Session,
  connection: Connection,
  database: string,
  names: readonly string[],
): Promise<TableAccess> {
  let proven: TableAccess = { readable: false, writable: false };
  for (
    let first = 0;
    first < names.length && !(proven.readable && proven.writable);
    first += TABLES_AT_ONCE
  ) {
    const batch = names.slice(first, first + TABLES_AT_ONCE);
    const access = await Within(session, () =>
      Promise.all(
        batch.map((name) => AccessOf(connection, database, name, proven)),
      ),
    );
    if (!connection.open) {
      throw new Error(DROPPED);
    }
    proven = {
      readable: access.some((table) => table.readable),
      writable: access.some((table) => table.writable),
    };
  }
  return proven;
}

/**
 * The tables of the database, or why the account reads none. The server answers a database it
 * lacks with an operation failure, and a name no database can have with a logic error; any other
 * error the server answers refuses or fails the listing. An error of the driver itself, such as a
 * closed connection, is no answer of the server, and throws.
 */
async function TableNamesOf(
  session: Session,
  connection: Connection,
  database: string,
): Promise<string[] | ProbeUnreadable> {
  try {
    return await Within(session, () =>
      r.db(database).tableList().run(connection),
    );
  } catch (error) {
    if (
      !isRethinkDBError(error) ||
      error.name === DRIVER_ERROR ||
      session.closer.signal.aborted
    ) {
      throw error;
    }
    return error.type === RethinkDBErrorType.QUERY_LOGIC ||
      (error.type === RethinkDBErrorType.OP_FAILED &&
        error.message.includes(MISSING))
      ? "no-database"
      : "cannot-list";
  }
}

async function SignIn(session: Session, url: string): Promise<ProbeAnswer> {
  const { connection: target, database } = ParseUrl(url);
  const connection = await r.connect({
    server: {
      host: target.host,
      port: target.port,
      signal: session.closes,
    },
    user: target.user,
    password: target.password,
    timeout: session.timeoutMs / MS_PER_SECOND,
    silent: true,
  });
  const started = performance.now();
  await Within(session, () => r.expr(1).run(connection));
  const latencyMs = Math.ceil(performance.now() - started);
  const signedIn = (rights: Rights): ProbeAnswer => ({
    outcome: "signed-in",
    latencyMs,
    user: target.user,
    ...rights,
  });
  if (!database) {
    return signedIn(Unreadable("no-database-named"));
  }
  const names = await TableNamesOf(session, connection, database);
  if (!Array.isArray(names)) {
    return signedIn(Unreadable(names));
  }
  const access = await AccessOfTables(session, connection, database, names);
  return signedIn({
    canRead: names.length === 0 || access.readable,
    canWrite: access.writable,
  });
}

async function Answer(session: Session, url: string): Promise<ProbeAnswer> {
  try {
    return await SignIn(session, url);
  } catch (error) {
    const { signal: closed } = session.closer;
    const cause: unknown = closed.aborted ? closed.reason : error;
    const message = cause instanceof Error ? cause.message : String(cause);
    return isRethinkDBError(cause) && cause.type === RethinkDBErrorType.AUTH
      ? { outcome: "refused", refusal: "credentials", message }
      : { outcome: "unreachable", message };
  }
}

/** Resolves to `ABORTED` when `signal` aborts, until `settled` does. */
function Aborted(
  signal: AbortSignal,
  settled: AbortSignal,
): Promise<ProbeAnswer> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(ABORTED), {
      once: true,
      signal: settled,
    });
  });
}

/**
 * Signs in to the RethinkDB server of `url` and asks it what the account may do to each table of
 * the database the URL's path names, with the catalog's own checks: an account reads a table when
 * the server answers its `info()`, and writes it when the server allows the delete of a key no row
 * has, which changes nothing. The client's `timeout` bounds only the connect, so each answer after
 * it is bounded by closing the connection. When `signal` aborts before the probe has settled, it
 * closes the connection and resolves at once to `unreachable` with "The probe was aborted.",
 * whatever the server has answered so far; already aborted, it opens no connection.
 */
export const probe: Probe = async ({ url, timeoutMs, signal }: ProbeConfig) => {
  if (signal.aborted) {
    return ABORTED;
  }
  const closer = new AbortController();
  const session: Session = {
    closer,
    closes: AbortSignal.any([signal, closer.signal]),
    timeoutMs,
  };
  try {
    return await Promise.race([
      Answer(session, url),
      Aborted(signal, closer.signal),
    ]);
  } finally {
    closer.abort(new Error(DONE));
  }
};
