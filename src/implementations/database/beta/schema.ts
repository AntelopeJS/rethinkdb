import { SchemaDefinition, SchemaOptions } from '@ajs.local/database/beta/schema';
import { assert } from 'console';
import { TermJson } from 'rethinkdb-ts/lib/internal-types';
import { TermType } from 'rethinkdb-ts/lib/proto/enums';
import { executeTermJson } from './query';

export function buildDatabaseName(schemaId: string, instanceId: string | undefined): string {
  return instanceId !== undefined ? `${schemaId}-${instanceId}` : schemaId;
}

export const existingSchemas: Record<string, { definition: SchemaDefinition; options: SchemaOptions }> = {};
export const existingInstances: Record<string, Set<string>> = {};
const registrationPromises: Record<string, Promise<void>> = {};

export const Schemas = {
  register(schemaId: string, schema: SchemaDefinition, options: SchemaOptions) {
    existingSchemas[schemaId] = { definition: schema, options };
    existingInstances[schemaId] = new Set<string>();
    registrationPromises[schemaId] = doRegister(schemaId, schema, options);
    return registrationPromises[schemaId];
  },
  unregister(schemaId: string) {
    delete existingSchemas[schemaId];
    delete existingInstances[schemaId];
    delete registrationPromises[schemaId];
  },
};

async function doRegister(schemaId: string, schema: SchemaDefinition, options: SchemaOptions) {
  const instances = await createTables(schemaId, schema, options.rowLevel);
  for (const instance of instances) {
    existingInstances[schemaId].add(instance);
  }
}

export async function WaitForRegistration(schemaId: string) {
  if (schemaId in registrationPromises) {
    await registrationPromises[schemaId];
  }
}

export function IsRowLevel(schemaId: string): boolean {
  return existingSchemas[schemaId]?.options?.rowLevel === true;
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

export function GetIndex(schemaId: string, tableId: string, indexId: string) {
  const table = GetTable(schemaId, tableId);
  if (indexId in table.indexes) {
    return table.indexes[indexId];
  }
  return { fields: [indexId] };
}

export function IsValidInstance(schemaId: string, instanceId: string | undefined) {
  if (!(schemaId in existingInstances)) {
    return false;
  }
  if (IsRowLevel(schemaId)) {
    if (instanceId === undefined) {
      throw new Error(`Row-level schema '${schemaId}' requires a tenant ID`);
    }
    return true;
  }
  return existingInstances[schemaId].has(instanceId ?? '');
}

export async function CreateInstance(schemaId: string, instanceId: string | undefined) {
  if (IsRowLevel(schemaId)) {
    return;
  }
  const schema = GetSchema(schemaId);
  existingInstances[schemaId].add(instanceId ?? '');
  await createSchemaInstance(schemaId, instanceId, schema);
}

export async function DestroyInstance(schemaId: string, instanceId: string | undefined) {
  if (IsRowLevel(schemaId)) {
    return;
  }
  assert(schemaId in existingInstances);
  const instances = existingInstances[schemaId];
  const key = instanceId ?? '';
  if (instances.has(key)) {
    instances.delete(key);
  }
  await destroySchemaInstance(schemaId, instanceId);
}

async function createTables(schemaId: string, schema: SchemaDefinition, rowLevel?: boolean): Promise<string[]> {
  const dbList: string[] = (await executeTermJson([TermType.DB_LIST, []])) ?? [];
  const prefix = schemaId + '-';
  const matchingDbs = dbList.filter((db) => db.startsWith(prefix));

  await Promise.all(matchingDbs.map((dbName) => initializeDatabase(dbName, schema)));

  const instances = matchingDbs.map((db) => db.substring(prefix.length));

  // global instance (no instanceId) or row-level (single DB)
  if (dbList.includes(schemaId)) {
    instances.push('');
    await initializeDatabase(schemaId, schema, rowLevel);
  } else if (rowLevel) {
    await executeTermJson([TermType.DB_CREATE, [schemaId]]);
    instances.push('');
    await initializeDatabase(schemaId, schema, rowLevel);
  }

  return instances;
}

async function createSchemaInstance(schemaId: string, instanceId: string | undefined, schema: SchemaDefinition) {
  const dbName = buildDatabaseName(schemaId, instanceId);
  const dbList: string[] = (await executeTermJson([TermType.DB_LIST, []])) ?? [];
  if (!dbList.includes(dbName)) {
    await executeTermJson([TermType.DB_CREATE, [dbName]]);
  }
  await initializeDatabase(dbName, schema);
}

async function destroySchemaInstance(schemaId: string, instanceId: string | undefined) {
  const dbName = buildDatabaseName(schemaId, instanceId);
  const dbList: string[] = (await executeTermJson([TermType.DB_LIST, []])) ?? [];
  if (dbList.includes(dbName)) {
    await executeTermJson([TermType.DB_DROP, [dbName]]);
  }
}

async function initializeDatabase(dbName: string, schema: SchemaDefinition, rowLevel?: boolean) {
  const db: TermJson = [TermType.DB, [dbName]];
  const tableList: string[] = (await executeTermJson([TermType.TABLE_LIST, [db]])) ?? [];

  await Promise.all(
    Object.keys(schema)
      .filter((t) => !tableList.includes(t))
      .map((t) => executeTermJson([TermType.TABLE_CREATE, [db, t], { primary_key: '_id' }])),
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
  const existingIndexList: string[] = (await executeTermJson([TermType.INDEX_LIST, [table]])) ?? [];

  let created = false;
  for (const [indexName, indexDef] of Object.entries(indexes)) {
    if (existingIndexList.includes(indexName)) {
      continue;
    }
    if (indexDef.fields && indexDef.fields.length > 0) {
      const argId = 0;
      const fields = indexDef.fields.map((f: string) => [TermType.BRACKET, [[TermType.VAR, [argId]], f]]);
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
      await executeTermJson([TermType.INDEX_CREATE, [table, indexName], indexDef.multi ? { multi: true } : {}]);
    }
    created = true;
  }
  if (rowLevel && !existingIndexList.includes('tenant_id')) {
    await executeTermJson([TermType.INDEX_CREATE, [table, 'tenant_id']]);
    created = true;
  }
  if (created) {
    await executeTermJson([TermType.INDEX_WAIT, [table]]);
  }
}
