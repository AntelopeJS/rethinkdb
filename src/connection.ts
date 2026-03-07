import assert from "node:assert";
import type { SchemaDefinition } from "@ajs.local/database/beta/schema";
import {
  type Connection,
  type MasterPool,
  type RConnectionOptions,
  type RPoolConnectionOptions,
  type RunOptions,
  r,
} from "rethinkdb-ts";
import type { RethinkDBConnection } from "rethinkdb-ts/lib/connection/connection";
import type { MasterConnectionPool } from "rethinkdb-ts/lib/connection/master-pool";
import { backtraceTerm } from "rethinkdb-ts/lib/error/term-backtrace";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import { TermType } from "rethinkdb-ts/lib/proto/enums";
import type { Cursor } from "rethinkdb-ts/lib/response/cursor";
import { Logger } from "./utils/logger";

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

export function GetConnection(): Connection | MasterPool | undefined {
  return connection?.connection;
}

export function GetConnectionType() {
  return connection?.type ?? "none";
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
    return results[0];
  }
  if (cursorType === "Cursor") {
    return await cursor.toArray();
  }
  return results;
}

export function buildDatabaseName(
  schemaId: string,
  instanceId: string | undefined,
): string {
  return instanceId !== undefined ? `${schemaId}-${instanceId}` : schemaId;
}

export async function CreateRowLevelDatabase(
  schemaId: string,
  schema: SchemaDefinition,
) {
  const dbList: string[] =
    (await executeTermJson([TermType.DB_LIST, []])) ?? [];
  if (!dbList.includes(schemaId)) {
    await executeTermJson([TermType.DB_CREATE, [schemaId]]);
  }
  await initializeDatabase(schemaId, schema, true);
}

export async function CreateSchemaInstance(
  schemaId: string,
  instanceId: string | undefined,
  schema: SchemaDefinition,
) {
  const dbName = buildDatabaseName(schemaId, instanceId);
  const dbList: string[] =
    (await executeTermJson([TermType.DB_LIST, []])) ?? [];
  if (!dbList.includes(dbName)) {
    await executeTermJson([TermType.DB_CREATE, [dbName]]);
  }
  await initializeDatabase(dbName, schema);
}

export async function DestroySchemaInstance(
  schemaId: string,
  instanceId: string | undefined,
) {
  const dbName = buildDatabaseName(schemaId, instanceId);
  const dbList: string[] =
    (await executeTermJson([TermType.DB_LIST, []])) ?? [];
  if (dbList.includes(dbName)) {
    await executeTermJson([TermType.DB_DROP, [dbName]]);
  }
}

async function initializeDatabase(
  dbName: string,
  schema: SchemaDefinition,
  rowLevel?: boolean,
) {
  const db: TermJson = [TermType.DB, [dbName]];
  const tableList: string[] =
    (await executeTermJson([TermType.TABLE_LIST, [db]])) ?? [];

  await Promise.all(
    Object.keys(schema)
      .filter((t) => !tableList.includes(t))
      .map((t) =>
        executeTermJson([
          TermType.TABLE_CREATE,
          [db, t],
          { primary_key: "_id" },
        ]),
      ),
  );

  await Promise.all(
    Object.entries(schema).map(([tableName, tableDef]) =>
      initializeIndexes(db, tableName, tableDef.indexes, rowLevel),
    ),
  );
}

async function initializeIndexes(
  db: TermJson,
  tableName: string,
  indexes: Record<string, any>,
  rowLevel?: boolean,
) {
  const table: TermJson = [TermType.TABLE, [db, tableName]];
  const existingIndexList: string[] =
    (await executeTermJson([TermType.INDEX_LIST, [table]])) ?? [];

  let created = false;
  for (const [indexName, indexDef] of Object.entries(indexes)) {
    if (existingIndexList.includes(indexName)) {
      continue;
    }
    if (indexDef.fields && indexDef.fields.length > 0) {
      const argId = 0;
      const fields = indexDef.fields.map((f: string) => [
        TermType.BRACKET,
        [[TermType.VAR, [argId]], f],
      ]);
      await executeTermJson([
        TermType.INDEX_CREATE,
        [
          table,
          indexName,
          [
            TermType.FUNC,
            [
              [TermType.MAKE_ARRAY, [argId]],
              [TermType.MAKE_ARRAY, fields],
            ],
          ],
        ],
        indexDef.multi ? { multi: true } : {},
      ]);
    } else {
      await executeTermJson([
        TermType.INDEX_CREATE,
        [table, indexName],
        indexDef.multi ? { multi: true } : {},
      ]);
    }
    created = true;
  }
  if (rowLevel && !existingIndexList.includes("tenant_id")) {
    await executeTermJson([TermType.INDEX_CREATE, [table, "tenant_id"]]);
    created = true;
  }
  if (created) {
    await executeTermJson([TermType.INDEX_WAIT, [table]]);
  }
}
