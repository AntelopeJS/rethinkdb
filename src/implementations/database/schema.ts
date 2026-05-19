import assert from "node:assert";
import type { SchemaDefinition } from "@antelopejs/interface-database/schema";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import { TermType } from "rethinkdb-ts/lib/proto/enums";
import { executeTermJson, InitializeSchemaDatabase } from "../../connection";
import { INSTANCE_REGISTRY_FIELD, INSTANCE_REGISTRY_TABLE } from "./utils";

const existingSchemas: Record<string, { definition: SchemaDefinition }> = {};

const schemaReady: Record<string, Promise<void>> = {};

const existingInstances: Record<string, Set<string>> = {};

export const Schemas = {
  async register(schemaId: string, schema: SchemaDefinition) {
    existingSchemas[schemaId] = { definition: schema };
    const ready = initializeSchema(schemaId, schema);
    schemaReady[schemaId] = ready;
    await ready;
  },
  unregister(schemaId: string) {
    delete existingSchemas[schemaId];
    delete schemaReady[schemaId];
    delete existingInstances[schemaId];
  },
};

async function initializeSchema(schemaId: string, schema: SchemaDefinition) {
  await InitializeSchemaDatabase(schemaId, schema);
  await hydrateInstances(schemaId);
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
  existingInstances[schemaId] = set;
}

export function WaitForSchemaReady(schemaId: string): Promise<void> {
  return schemaReady[schemaId] ?? Promise.resolve();
}

export function GetSchema(schemaId: string) {
  assert(schemaId in existingSchemas);
  return existingSchemas[schemaId].definition;
}

export function GetTable(schemaId: string, tableId: string) {
  const schema = GetSchema(schemaId);
  assert(tableId in schema);
  return schema[tableId];
}

export function HasIndex(
  schemaId: string,
  tableId: string,
  indexId: string,
): boolean {
  const table = GetTable(schemaId, tableId);
  return indexId in table.indexes;
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
  return existingInstances[schemaId]?.has(instanceId ?? "") ?? false;
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
  if (!existingInstances[schemaId]) {
    existingInstances[schemaId] = new Set<string>();
  }
  existingInstances[schemaId].add(id);
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

  existingInstances[schemaId]?.delete(id);
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
    { index: "tenant_id" },
  ];
  await executeTermJson([TermType.DELETE, [matching]]);
}

export async function ListInstances(schemaId: string): Promise<string[]> {
  await WaitForSchemaReady(schemaId);
  const set = existingInstances[schemaId];
  if (!set) {
    return [];
  }
  return Array.from(set).filter((id) => id !== "");
}
