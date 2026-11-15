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
const ABORTED: ProbeAnswer = {
  outcome: "unreachable",
  message: "The probe was aborted.",
};
const MISSING = "does not exist";

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

async function AccessOf(
  connection: Connection,
  database: string,
  name: string,
): Promise<TableAccess> {
  const table = r.db(database).table(name);
  const [readable, writes] = await Promise.all([
    TableInfoOf(table, connection).then(
      () => true,
      () => false,
    ),
    Writes(table, connection),
  ]);
  return {
    readable,
    writable: writes.insert || writes.update || writes.delete,
  };
}

async function AccessOfTables(
  session: Session,
  connection: Connection,
  database: string,
  names: readonly string[],
): Promise<TableAccess[]> {
  const access: TableAccess[] = [];
  for (let first = 0; first < names.length; first += TABLES_AT_ONCE) {
    const batch = names.slice(first, first + TABLES_AT_ONCE);
    access.push(
      ...(await Within(session, () =>
        Promise.all(batch.map((name) => AccessOf(connection, database, name))),
      )),
    );
  }
  return access;
}

/** The tables of the database, or why the account reads none. */
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
    if (!isRethinkDBError(error) || session.closer.signal.aborted) {
      throw error;
    }
    if (error.type === RethinkDBErrorType.PERMISSION_ERROR) {
      return "cannot-list";
    }
    if (
      error.type === RethinkDBErrorType.OP_FAILED &&
      error.message.includes(MISSING)
    ) {
      return "no-database";
    }
    throw error;
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
    canRead: access.length === 0 || access.some((table) => table.readable),
    canWrite: access.some((table) => table.writable),
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
