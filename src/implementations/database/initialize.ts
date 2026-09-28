import { setTimeout } from "node:timers/promises";
import { RethinkDBErrorType } from "rethinkdb-ts";
import { TermType } from "rethinkdb-ts/lib/proto/enums";
import { isRethinkDBError } from "rethinkdb-ts/lib/error/error";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import type {
  IndexDefinition,
  SchemaDefinition,
} from "@antelopejs/interface-database/schema";

import { Logger } from "../../utils/logger";
import { executeTermJson } from "../../connection";
import { buildIndexCreations } from "./indexes";
import { INSTANCE_REGISTRY_TABLE, PRIMARY_KEY_FIELD } from "./utils";

const ALREADY_EXISTS_PATTERN = /already exists/;
const INITIALIZATION_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY_MS = 200;

function isAlreadyExists(error: unknown): boolean {
  return (
    isRethinkDBError(error) &&
    error.type === RethinkDBErrorType.OP_FAILED &&
    ALREADY_EXISTS_PATTERN.test(error.message)
  );
}

async function createIfMissing(term: TermJson) {
  try {
    await executeTermJson(term);
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
  }
}

async function listNames(term: TermJson): Promise<string[]> {
  return (await executeTermJson(term)) ?? [];
}

export async function ensureDatabase(dbName: string) {
  const databases = await listNames([TermType.DB_LIST, []]);
  if (!databases.includes(dbName)) {
    await createIfMissing([TermType.DB_CREATE, [dbName]]);
  }
}

async function ensureTables(dbName: string, tableNames: string[]) {
  const db: TermJson = [TermType.DB, [dbName]];
  const existing = await listNames([TermType.TABLE_LIST, [db]]);
  const missing = tableNames.filter((name) => !existing.includes(name));
  await Promise.all(
    missing.map((name) =>
      createIfMissing([
        TermType.TABLE_CREATE,
        [db, name],
        { primary_key: PRIMARY_KEY_FIELD },
      ]),
    ),
  );
  await executeTermJson([TermType.WAIT, [db]]);
}

async function ensureIndexes(
  table: TermJson,
  indexes: Record<string, IndexDefinition>,
) {
  const existing = await listNames([TermType.INDEX_LIST, [table]]);
  const missing = buildIndexCreations(table, indexes).filter(
    (creation) => !existing.includes(creation.name),
  );
  for (const creation of missing) {
    Logger.Debug("Creating index", creation.name);
    await createIfMissing(creation.term);
  }
  await executeTermJson([TermType.INDEX_WAIT, [table]]);
}

/**
 * Creates the missing schema database, tables and indexes, ignoring "already
 * exists" errors from other processes, then waits until every index is ready.
 */
export async function InitializeSchemaDatabase(
  dbName: string,
  schema: SchemaDefinition,
) {
  await ensureDatabase(dbName);
  await ensureTables(dbName, [...Object.keys(schema), INSTANCE_REGISTRY_TABLE]);
  const db: TermJson = [TermType.DB, [dbName]];
  await Promise.all(
    Object.entries(schema).map(([tableName, tableDef]) =>
      ensureIndexes([TermType.TABLE, [db, tableName]], tableDef.indexes),
    ),
  );
}

export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  attempts = INITIALIZATION_ATTEMPTS,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts) {
        throw error;
      }
      const delay = INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1);
      Logger.Warn(
        `Schema initialization failed (attempt ${attempt}/${attempts}), retrying in ${delay}ms:`,
        error,
      );
      await setTimeout(delay);
    }
  }
}
