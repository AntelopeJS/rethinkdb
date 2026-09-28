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

export async function executeTermJson(term: TermJson): Promise<any> {
  Logger.Debug("Executing query:", backtraceTerm(term)[0]);
  const cursor = await SendQuery(term);
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
