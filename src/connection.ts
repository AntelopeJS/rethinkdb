import assert from "node:assert";
import {
  type Connection,
  type RConnectionOptions,
  type RPoolConnectionOptions,
  type RunOptions,
  r,
} from "rethinkdb-ts";
import type { Cursor } from "rethinkdb-ts/lib/response/cursor";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import { RethinkDBConnection } from "rethinkdb-ts/lib/connection/connection";
import { MasterConnectionPool } from "rethinkdb-ts/lib/connection/master-pool";

import { Logger } from "./utils/logger";
import { IsWriteResult, validateWriteResult } from "./write-result";

let connection:
  | {
      type: "direct";
      connection: RethinkDBConnection;
    }
  | {
      type: "pool";
      connection: MasterConnectionPool;
    }
  | undefined;

async function OpenConnection(
  options: RConnectionOptions,
): Promise<RethinkDBConnection> {
  const opened = await r.connect(options);
  assert(
    opened instanceof RethinkDBConnection,
    "r.connect answered no RethinkDBConnection",
  );
  return opened;
}

async function OpenPool(
  options: RPoolConnectionOptions,
): Promise<MasterConnectionPool> {
  const opened = await r.connectPool(options);
  assert(
    opened instanceof MasterConnectionPool,
    "r.connectPool answered no MasterConnectionPool",
  );
  return opened;
}

export async function ConnectDirect(options: RConnectionOptions) {
  Logger.Debug("Connecting directly to RethinkDB", options.host ?? "localhost");
  Disconnect();
  connection = {
    type: "direct",
    connection: await OpenConnection(options),
  };
  Logger.Debug("Connected directly to RethinkDB");
}

export async function ConnectPool(options: RPoolConnectionOptions) {
  Logger.Debug("Connecting to RethinkDB pool");
  Disconnect();
  connection = {
    type: "pool",
    connection: await OpenPool(options),
  };
  Logger.Debug("Connected to RethinkDB pool");
}

export function Disconnect() {
  DropDirect();
  directOptions = undefined;
  if (connection) {
    Logger.Debug("Disconnecting from RethinkDB", connection.type);
    switch (connection.type) {
      case "direct":
        void connection.connection.close();
        break;
      case "pool":
        void connection.connection.drain();
        break;
    }
  }
}

export function SendQuery(
  query: TermJson,
  opts?: RunOptions,
): Promise<Cursor | undefined> {
  assert(connection, "No connection established");
  Logger.Debug("Sending query via", connection.type);
  switch (connection.type) {
    case "direct":
      return connection.connection.query(query, opts);
    case "pool":
      return connection.connection.queue(query, opts);
  }
}

async function Resolve(
  term: TermJson,
  cursor: Cursor | undefined,
): Promise<any> {
  if (!cursor) {
    return undefined;
  }
  const results = await cursor.resolve();
  if (!results) {
    return undefined;
  }
  const cursorType = cursor.getType();
  if (cursorType === "Atom") {
    const atom: unknown = results[0];
    validateWriteResult(term, IsWriteResult(atom) ? atom : undefined);
    return atom;
  }
  if (cursorType === "Cursor") {
    return await cursor.toArray();
  }
  return results;
}

export async function executeTermJson(term: TermJson): Promise<any> {
  return Resolve(term, await SendQuery(term));
}

/** A read stopped because it ran past `statementTimeoutMs`. */
export class QueryTimeoutError extends Error {
  public readonly status = "timeout";

  public constructor(timeoutMs: number) {
    super(`The query did not finish within ${timeoutMs} ms, and was stopped`);
    this.name = "QueryTimeoutError";
  }
}

let directOptions: RConnectionOptions | undefined;

/** The connections of bounded reads that finished within their limit, kept open for the next one. */
const idleDirect: RethinkDBConnection[] = [];

/** The bounded-read connections opened with the current options; only these go back to idle. */
let currentDirect = new WeakSet<RethinkDBConnection>();

async function BorrowDirect(): Promise<RethinkDBConnection> {
  assert(directOptions, "No connection established");
  let idle = idleDirect.pop();
  while (idle && !idle.open) {
    idle = idleDirect.pop();
  }
  if (idle) {
    return idle;
  }
  const current = currentDirect;
  const opened = await OpenConnection(directOptions);
  current.add(opened);
  return opened;
}

/** Closes the idle bounded-read connections, and those still borrowed once their read ends. */
function DropDirect() {
  for (const idle of idleDirect.splice(0)) {
    void idle.close().catch(() => undefined);
  }
  currentDirect = new WeakSet();
}

/**
 * Keeps `direct` for the next bounded read, unless a read past its limit closed it or the
 * options changed or the instance disconnected while it was borrowed.
 */
function GiveBack(direct: RethinkDBConnection) {
  if (!currentDirect.has(direct)) {
    void direct.close().catch(() => undefined);
    return;
  }
  if (direct.open) {
    idleDirect.push(direct);
  }
}

/** The options a bounded read opens its own connection with. */
export function SetDirectOptions(options: RConnectionOptions) {
  DropDirect();
  directOptions = options;
}

/**
 * A cursor on a connection of its own. Each wait on the server is armed with the time limit; the
 * connection closes when one runs out, which stops the query on the server.
 */
export interface BoundedCursor {
  cursor: Cursor;
  arm: () => void;
  disarm: () => void;
  release: () => void;
  expired: () => boolean;
}

/**
 * Opens a read's cursor on a connection of its own, bounding the wait for its first results by
 * `timeoutMs`; the caller arms each later wait the same way.
 */
export async function OpenBoundedCursor(
  term: TermJson,
  timeoutMs: number,
): Promise<BoundedCursor> {
  const direct = await BorrowDirect();
  let expired = false;
  let timer: NodeJS.Timeout | undefined;
  let expire: (error: Error) => void = () => undefined;
  const deadline = new Promise<never>((_, reject) => {
    expire = reject;
  });
  const disarm = () => clearTimeout(timer);
  const arm = () => {
    disarm();
    timer = setTimeout(() => {
      expired = true;
      expire(new QueryTimeoutError(timeoutMs));
      void direct.close().catch(() => undefined);
    }, timeoutMs);
  };
  const release = () => {
    disarm();
    GiveBack(direct);
  };
  arm();
  try {
    const opening = direct.query(term);
    const cursor = await Promise.race([opening, deadline]);
    assert(cursor, "Query returned no cursor.");
    disarm();
    return { cursor, arm, disarm, release, expired: () => expired };
  } catch (error) {
    release();
    throw error;
  }
}

/** A connection of its own, with the options the instance connected with. */
export function DirectConnection(): Promise<Connection> {
  assert(directOptions, "No connection established");
  return r.connect(directOptions);
}

/**
 * Runs a read on a connection of its own, closed once `timeoutMs` passes: RethinkDB has no
 * server-side time limit, and closing the connection stops the query on the server.
 */
export async function executeBounded(
  term: TermJson,
  timeoutMs: number,
): Promise<any> {
  const direct = await BorrowDirect();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new QueryTimeoutError(timeoutMs));
      void direct.close().catch(() => undefined);
    }, timeoutMs);
  });
  try {
    const running = direct.query(term).then((cursor) => Resolve(term, cursor));
    return await Promise.race([running, expired]);
  } finally {
    clearTimeout(timer);
    GiveBack(direct);
  }
}
