import assert from "node:assert";
import { TermType } from "rethinkdb-ts/lib/proto/enums";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import type {
  IndexDefinition,
  SchemaDefinition,
} from "@antelopejs/interface-database/schema";

import { executeTermJson } from "../../connection";
import { IsExternal } from "../../config";
import {
  type ExternalTable,
  RegisterExternalSchema,
} from "./external-registration";
import { InitializeSchemaDatabase, retryWithBackoff } from "./initialize";
import { assertNoUniqueIndexes, assertValidIndexNames } from "./indexes";
import {
  INSTANCE_REGISTRY_FIELD,
  INSTANCE_REGISTRY_TABLE,
  TENANT_ID_FIELD,
} from "./utils";

const existingSchemas: Record<string, { definition: SchemaDefinition }> = {};

const schemaReady = new Map<string, Promise<void>>();

const existingInstances = new Map<string, Set<string>>();

const externalTables = new Map<string, Record<string, ExternalTable>>();

/**
 * Registers an external schema: its gate keeps a failure, so every query on the schema rethrows
 * the message registration failed with, as a schema that never registered would not.
 */
async function registerExternal(schemaId: string, schema: SchemaDefinition) {
  const registration = RegisterExternalSchema(schemaId, schema).then(
    (tables) => {
      externalTables.set(schemaId, tables);
    },
  );
  schemaReady.set(schemaId, registration);
  registration.catch(() => undefined);
  await registration;
}

/** The table an external schema's table reads, as its registration described it. */
export function GetExternalTable(
  schemaId: string,
  tableId: string,
): ExternalTable {
  const table = externalTables.get(schemaId)?.[tableId];
  assert(table, `Table '${schemaId}.${tableId}' is not registered`);
  return table;
}

export const Schemas = {
  async register(schemaId: string, schema: SchemaDefinition) {
    existingSchemas[schemaId] = { definition: schema };
    if (IsExternal()) {
      return registerExternal(schemaId, schema);
    }
    const ready = initializeSchema(schemaId, schema);
    schemaReady.set(schemaId, ready);
    try {
      await ready;
    } catch (err) {
      delete existingSchemas[schemaId];
      schemaReady.delete(schemaId);
      existingInstances.delete(schemaId);
      throw err;
    }
  },
  unregister(schemaId: string) {
    externalTables.delete(schemaId);
    delete existingSchemas[schemaId];
    schemaReady.delete(schemaId);
    existingInstances.delete(schemaId);
  },
};

async function initializeSchema(schemaId: string, schema: SchemaDefinition) {
  assertValidIndexNames(schema);
  assertNoUniqueIndexes(schemaId, schema);
  await retryWithBackoff(async () => {
    await InitializeSchemaDatabase(schemaId, schema);
    await hydrateInstances(schemaId);
  });
}

async function hydrateInstances(schemaId: string) {
  const table: TermJson = [
    TermType.TABLE,
    [[TermType.DB, [schemaId]], INSTANCE_REGISTRY_TABLE],
  ];
  const rows: Array<{ _id: string; instance_id: string }> =
    (await executeTermJson(table)) ?? [];
  const set = new Set<string>();
  for (const row of rows) {
    set.add(row.instance_id);
  }
  existingInstances.set(schemaId, set);
}

export function WaitForSchemaReady(schemaId: string): Promise<void> {
  return schemaReady.get(schemaId) ?? Promise.resolve();
}

export function GetSchema(schemaId: string) {
  assert(schemaId in existingSchemas);
  assert(Object.prototype.hasOwnProperty.call(existingSchemas, schemaId));
  return existingSchemas[schemaId].definition;
}

export function GetTable(schemaId: string, tableId: string) {
  const schema = GetSchema(schemaId);
  assert(tableId in schema);
  return schema[tableId];
}

export function FindIndex(
  schemaId: string,
  tableId: string,
  indexId: string,
): IndexDefinition | undefined {
  const table = GetTable(schemaId, tableId);
  return indexId in table.indexes ? table.indexes[indexId] : undefined;
}

export function GetIndex(
  schemaId: string,
  tableId: string,
  indexId: string,
  onlyIndex?: boolean,
) {
  const table = GetTable(schemaId, tableId);
  if (indexId in table.indexes) {
    return table.indexes[indexId];
  }
  assert(!onlyIndex);
  return { fields: [indexId] };
}

export function IsValidInstance(
  schemaId: string,
  instanceId: string | undefined,
): boolean {
  return existingInstances.get(schemaId)?.has(instanceId ?? "") ?? false;
}

export async function CreateInstance(
  schemaId: string,
  instanceId: string | undefined,
): Promise<string> {
  await WaitForSchemaReady(schemaId);
  const id = instanceId ?? "";
  const registryTable: TermJson = [
    TermType.TABLE,
    [[TermType.DB, [schemaId]], INSTANCE_REGISTRY_TABLE],
  ];
  await executeTermJson([
    TermType.INSERT,
    [registryTable, { _id: id, [INSTANCE_REGISTRY_FIELD]: id }],
    { conflict: "replace" },
  ]);
  let instances = existingInstances.get(schemaId);
  if (!instances) {
    instances = new Set<string>();
    existingInstances.set(schemaId, instances);
  }
  instances.add(id);
  return id;
}

export async function DestroyInstance(
  schemaId: string,
  instanceId: string | undefined,
): Promise<void> {
  await WaitForSchemaReady(schemaId);
  const id = instanceId ?? "";
  const schema = GetSchema(schemaId);
  const db: TermJson = [TermType.DB, [schemaId]];

  await Promise.all(
    Object.keys(schema).map((tableName) =>
      deleteInstanceRows(db, tableName, id),
    ),
  );

  const registryTable: TermJson = [
    TermType.TABLE,
    [db, INSTANCE_REGISTRY_TABLE],
  ];
  await executeTermJson([
    TermType.DELETE,
    [[TermType.GET, [registryTable, id]]],
  ]);

  existingInstances.get(schemaId)?.delete(id);
}

async function deleteInstanceRows(
  db: TermJson,
  tableName: string,
  instanceId: string,
) {
  const table: TermJson = [TermType.TABLE, [db, tableName]];
  const matching: TermJson = [
    TermType.GET_ALL,
    [table, instanceId],
    { index: TENANT_ID_FIELD },
  ];
  await executeTermJson([TermType.DELETE, [matching]]);
}

export async function ListInstances(schemaId: string): Promise<string[]> {
  await WaitForSchemaReady(schemaId);
  const set = existingInstances.get(schemaId);
  if (!set) {
    return [];
  }
  return Array.from(set).filter((id) => id !== "");
}
