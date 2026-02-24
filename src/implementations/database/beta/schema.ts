import { SchemaDefinition } from '@ajs.local/database/beta/schema';
import { assert } from 'console';
import { TermJson } from 'rethinkdb-ts/lib/internal-types';
import { TermType } from 'rethinkdb-ts/lib/proto/enums';
import { executeTermJson } from './query';

export const existingSchemas: Record<string, SchemaDefinition> = {};
export const existingInstances: Record<string, Set<string>> = {};
const registrationPromises: Record<string, Promise<void>> = {};

export const Schemas = {
  register(schemaId: string, schema: SchemaDefinition) {
    existingSchemas[schemaId] = schema;
    existingInstances[schemaId] = new Set<string>();
    registrationPromises[schemaId] = doRegister(schemaId, schema);
    return registrationPromises[schemaId];
  },
  unregister(schemaId: string) {
    delete existingSchemas[schemaId];
    delete existingInstances[schemaId];
    delete registrationPromises[schemaId];
  },
};

async function doRegister(schemaId: string, schema: SchemaDefinition) {
  const instances = await createTables(schemaId, schema);
  for (const instance of instances) {
    existingInstances[schemaId].add(instance);
  }
  await CreateInstance(schemaId, 'default');
}

export async function WaitForRegistration(schemaId: string) {
  if (schemaId in registrationPromises) {
    await registrationPromises[schemaId];
  }
}

export function GetSchema(schemaId: string) {
  assert(schemaId in existingSchemas);
  return existingSchemas[schemaId];
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

export function IsValidInstance(schemaId: string, instanceId: string) {
  if (!(schemaId in existingInstances)) {
    return false;
  }
  return existingInstances[schemaId].has(instanceId);
}

export async function CreateInstance(schemaId: string, instanceId: string) {
  const schema = GetSchema(schemaId);
  existingInstances[schemaId].add(instanceId);
  await createSchemaInstance(schemaId, instanceId, schema);
}

export async function DestroyInstance(schemaId: string, instanceId: string) {
  assert(schemaId in existingInstances);
  const instances = existingInstances[schemaId];
  if (instances.has(instanceId)) {
    instances.delete(instanceId);
  }
  await destroySchemaInstance(schemaId, instanceId);
}

async function createTables(schemaId: string, schema: SchemaDefinition): Promise<string[]> {
  const dbList: string[] = (await executeTermJson([TermType.DB_LIST, []])) ?? [];
  const instances: string[] = [];
  const prefix = schemaId + '-';

  for (const dbName of dbList) {
    if (!dbName.startsWith(prefix)) {
      continue;
    }
    instances.push(dbName.substring(prefix.length));
    await initializeDatabase(dbName, schema);
  }

  return instances;
}

async function createSchemaInstance(schemaId: string, instanceId: string, schema: SchemaDefinition) {
  const dbName = `${schemaId}-${instanceId}`;
  const dbList: string[] = (await executeTermJson([TermType.DB_LIST, []])) ?? [];
  if (!dbList.includes(dbName)) {
    await executeTermJson([TermType.DB_CREATE, [dbName]]);
  }
  await initializeDatabase(dbName, schema);
}

async function destroySchemaInstance(schemaId: string, instanceId: string) {
  const dbName = `${schemaId}-${instanceId}`;
  const dbList: string[] = (await executeTermJson([TermType.DB_LIST, []])) ?? [];
  if (dbList.includes(dbName)) {
    await executeTermJson([TermType.DB_DROP, [dbName]]);
  }
}

async function initializeDatabase(dbName: string, schema: SchemaDefinition) {
  const db: TermJson = [TermType.DB, [dbName]];
  const tableList: string[] = (await executeTermJson([TermType.TABLE_LIST, [db]])) ?? [];

  for (const [tableName, tableDef] of Object.entries(schema)) {
    if (!tableList.includes(tableName)) {
      await executeTermJson([TermType.TABLE_CREATE, [db, tableName], { primary_key: '_id' }]);
    }
    await initializeIndexes(db, tableName, tableDef.indexes);
  }
}

async function initializeIndexes(db: TermJson, tableName: string, indexes: Record<string, any>) {
  const table: TermJson = [TermType.TABLE, [db, tableName]];
  const existingIndexList: string[] = (await executeTermJson([TermType.INDEX_LIST, [table]])) ?? [];

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
    await executeTermJson([TermType.INDEX_WAIT, [table]]);
  }
}
