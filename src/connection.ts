import assert from "node:assert";
import type { Cursor } from "rethinkdb-ts/lib/response/cursor";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import { backtraceTerm } from "rethinkdb-ts/lib/error/term-backtrace";
import type { RethinkDBConnection } from "rethinkdb-ts/lib/connection/connection";
import type { MasterConnectionPool } from "rethinkdb-ts/lib/connection/master-pool";
import {
  type Connection,
  type MasterPool,
  type RConnectionOptions,
  type RPoolConnectionOptions,
  type RunOptions,
  r,
} from "rethinkdb-ts";

import { Logger } from "./utils/logger";
import { validateWriteResult } from "./write-result";

let connection:
  | {
      type: "direct";
      connection: Connection;
    }
  | {
      type: "pool";
      connection: MasterPool;
    }
  | undefined;

export async function ConnectDirect(options: RConnectionOptions) {
  Logger.Debug("Connecting directly to RethinkDB", options.host ?? "localhost");
  Disconnect();
  connection = {
    type: "direct",
    connection: await r.connect(options),
  };
  Logger.Debug("Connected directly to RethinkDB");
}

export async function ConnectPool(options: RPoolConnectionOptions) {
  Logger.Debug("Connecting to RethinkDB pool");
  Disconnect();
  connection = {
    type: "pool",
    connection: await r.connectPool(options),
  };
  Logger.Debug("Connected to RethinkDB pool");
}

export function Disconnect() {
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
      return (<RethinkDBConnection>connection.connection).query(query, opts);
    case "pool":
      return (<MasterConnectionPool>connection.connection).queue(query, opts);
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
    validateWriteResult(term, results[0]);
    return results[0];
  }
  if (cursorType === "Cursor") {
    return await cursor.toArray();
  }
  return results;
}

export async function executeTermJson(term: TermJson): Promise<any> {
  Logger.Debug("Executing query:", backtraceTerm(term)[0]);
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

/** The options a bounded read opens its own connection with. */
export function SetDirectOptions(options: RConnectionOptions) {
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
  assert(directOptions, "No connection established");
  const direct = await r.connect(directOptions);
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
    void direct.close().catch(() => undefined);
  };
  arm();
  try {
    // SAFETY: r.connect answers the driver's RethinkDBConnection, whose query() takes raw terms.
    const opening = (<RethinkDBConnection>direct).query(term);
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
  assert(directOptions, "No connection established");
  const direct = await r.connect(directOptions);
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new QueryTimeoutError(timeoutMs));
      void direct.close();
    }, timeoutMs);
  });
  try {
    // SAFETY: r.connect answers the driver's RethinkDBConnection, whose query() takes raw terms.
    const running = (<RethinkDBConnection>direct)
      .query(term)
      .then((cursor) => Resolve(term, cursor));
    return await Promise.race([running, expired]);
  } finally {
    clearTimeout(timer);
    void direct.close().catch(() => undefined);
  }
}
