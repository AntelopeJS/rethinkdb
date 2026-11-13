import { setTimeout } from "node:timers/promises";
import { RethinkDBErrorType } from "rethinkdb-ts";
import { TermType } from "rethinkdb-ts/lib/proto/enums";
import {
  isRethinkDBError,
  type RethinkDBError,
} from "rethinkdb-ts/lib/error/error";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import type {
  IndexDefinition,
  SchemaDefinition,
} from "@antelopejs/interface-database/schema";

import { Logger } from "../../utils/logger";
import { executeTermJson } from "../../connection";
import {
  buildIndexCreations,
  type IndexCreation,
  REBUILD_INDEX_SUFFIX,
} from "./indexes";
import { type IndexPlan, planIndexes } from "./index-state";
import {
  INSTANCE_REGISTRY_TABLE,
  IsTextList,
  PRIMARY_KEY_FIELD,
} from "./utils";

const ALREADY_EXISTS_PATTERN = /already exists/;
const INITIALIZATION_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY_MS = 200;
const REBUILD_ATTEMPTS = 5;

function isAlreadyExists(error: unknown): error is RethinkDBError {
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
  const names: unknown = await executeTermJson(term);
  return IsTextList(names) ? names : [];
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

function createIndex(table: TermJson, name: string, creation: IndexCreation) {
  const options = creation.multi ? { multi: true } : {};
  return createIfMissing([
    TermType.INDEX_CREATE,
    [table, name, creation.fn],
    options,
  ]);
}

async function swapInRebuild(table: TermJson, plan: IndexPlan) {
  const { creation, rebuildState } = plan;
  const rebuild = `${creation.name}${REBUILD_INDEX_SUFFIX}`;
  if (rebuildState === "stale" || rebuildState === "unreadable") {
    await executeTermJson([TermType.INDEX_DROP, [table, rebuild]]);
  }
  await createIndex(table, rebuild, creation);
  await executeTermJson([TermType.INDEX_WAIT, [table, rebuild]]);
  await executeTermJson([
    TermType.INDEX_RENAME,
    [table, rebuild, creation.name],
    { overwrite: true },
  ]);
}

/**
 * Builds the declared function under `<name>__rebuild`, then renames it over
 * the stale index, which keeps answering reads until the swap. A leftover
 * `<name>__rebuild` built by another function is dropped first. Other
 * processes booting at once race on the same names, so a failed attempt
 * reads the index again: it stops once the index is current, and retries
 * from the state it reads otherwise.
 */
async function rebuildIndex(table: TermJson, plan: IndexPlan) {
  Logger.Warn(
    `Index '${plan.creation.name}' was built from another definition; rebuilding it`,
  );
  let attempt = plan;
  for (let remaining = REBUILD_ATTEMPTS - 1; ; remaining--) {
    try {
      await swapInRebuild(table, attempt);
      return;
    } catch (error) {
      [attempt] = await planIndexes(table, [plan.creation]);
      if (attempt.state === "current") {
        return;
      }
      if (remaining === 0) {
        throw error;
      }
    }
  }
}

async function applyIndexPlan(table: TermJson, plan: IndexPlan) {
  const { name } = plan.creation;
  switch (plan.state) {
    case "missing":
      Logger.Debug("Creating index", name);
      await createIndex(table, name, plan.creation);
      return;
    case "stale":
      await rebuildIndex(table, plan);
      return;
    case "unreadable":
      Logger.Warn(
        `Index '${name}' is stored in a form that cannot be compared with its definition; keeping it`,
      );
      return;
    case "current":
      return;
  }
}

async function ensureIndexes(
  table: TermJson,
  indexes: Record<string, IndexDefinition>,
) {
  const creations = buildIndexCreations(indexes);
  for (const plan of await planIndexes(table, creations)) {
    await applyIndexPlan(table, plan);
  }
  const managed = creations.map((creation) => creation.name);
  await executeTermJson([TermType.INDEX_WAIT, [table, ...managed]]);
}

/**
 * Creates the missing schema database, tables and indexes, ignoring "already
 * exists" errors from other processes, rebuilds each index whose stored
 * function or `multi` flag differs from its definition, then waits until the
 * indexes it manages are ready.
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
