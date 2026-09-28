import { TermType } from "rethinkdb-ts/lib/proto/enums";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import type {
  IndexDefinition,
  SchemaDefinition,
} from "@antelopejs/interface-database/schema";

import { Logger } from "../../utils/logger";
import { allocateArgNumber, TENANT_ID_FIELD } from "./utils";

const INSTANCE_INDEX_SUFFIX = "__i";
const ARRAY_TYPE_NAME = "ARRAY";

type TermBuilder = (value: TermJson) => TermJson;

export interface IndexCreation {
  name: string;
  term: TermJson;
}

interface IndexedLookup {
  index?: string;
  key: TermBuilder;
}

export interface IndexedRead {
  lookup: (source: TermJson, target: IndexedLookup) => TermJson;
  matches: TermBuilder;
}

export interface DeclaredIndex {
  schemaId: string;
  tableName: string;
  indexName: string;
  definition: IndexDefinition;
}

export interface IndexedReadTarget extends DeclaredIndex {
  table: TermJson;
  source: TermJson;
  tenantId?: string;
}

const warnedIndexes = new Map<string, Map<string, Set<string>>>();

function instanceIndexName(indexName: string): string {
  return `${indexName}${INSTANCE_INDEX_SUFFIX}`;
}

function buildFunction(body: TermBuilder): TermJson {
  const argId = allocateArgNumber();
  return [
    TermType.FUNC,
    [[TermType.MAKE_ARRAY, [argId]], body([TermType.VAR, [argId]])],
  ];
}

function readField(row: TermJson, field: string): TermJson {
  return [TermType.BRACKET, [row, field]];
}

function isCompound(definition: IndexDefinition): boolean {
  return (definition.fields?.length ?? 0) > 0;
}

function creationOptions(definition: IndexDefinition) {
  return definition.multi ? { multi: true } : {};
}

export function indexOptions(index?: string) {
  return index ? { index } : {};
}

function indexedFields(
  indexName: string,
  definition: IndexDefinition,
): string[] {
  const fields = definition.fields ?? [];
  return fields.length > 0 ? fields : [indexName];
}

function buildIndexValue(
  row: TermJson,
  indexName: string,
  definition: IndexDefinition,
): TermJson {
  const fields = definition.fields ?? [];
  if (fields.length === 0) {
    return readField(row, indexName);
  }
  return [TermType.MAKE_ARRAY, fields.map((field) => readField(row, field))];
}

function buildIndexEntries(value: TermJson): TermJson {
  const isArray: TermJson = [
    TermType.EQ,
    [[TermType.TYPE_OF, [value]], ARRAY_TYPE_NAME],
  ];
  return [TermType.BRANCH, [isArray, value, [TermType.MAKE_ARRAY, [value]]]];
}

function buildInstanceKey(
  tenantId: TermJson,
  definition: IndexDefinition,
  value: TermJson,
): TermJson {
  if (isCompound(definition) && !definition.multi) {
    return [TermType.PREPEND, [value, tenantId]];
  }
  return [TermType.MAKE_ARRAY, [tenantId, value]];
}

function buildInstanceIndexFunction(
  indexName: string,
  definition: IndexDefinition,
): TermJson {
  return buildFunction((row) => {
    const tenantId = readField(row, TENANT_ID_FIELD);
    const value = buildIndexValue(row, indexName, definition);
    if (!definition.multi) {
      return buildInstanceKey(tenantId, definition, value);
    }
    const toKey = buildFunction((entry) =>
      buildInstanceKey(tenantId, definition, entry),
    );
    return [TermType.MAP, [buildIndexEntries(value), toKey]];
  });
}

function buildInstanceIndexCreation(
  table: TermJson,
  indexName: string,
  definition: IndexDefinition,
): IndexCreation {
  const name = instanceIndexName(indexName);
  const indexFunction = buildInstanceIndexFunction(indexName, definition);
  return {
    name,
    term: [
      TermType.INDEX_CREATE,
      [table, name, indexFunction],
      creationOptions(definition),
    ],
  };
}

function buildGlobalIndexCreation(
  table: TermJson,
  indexName: string,
  definition: IndexDefinition,
): IndexCreation {
  const args: TermJson[] = isCompound(definition)
    ? [
        table,
        indexName,
        buildFunction((row) => buildIndexValue(row, indexName, definition)),
      ]
    : [table, indexName];
  return {
    name: indexName,
    term: [TermType.INDEX_CREATE, args, creationOptions(definition)],
  };
}

/**
 * Rejects declared index names that would collide with the generated
 * `<name>__i` indexes.
 */
export function assertValidIndexNames(schema: SchemaDefinition) {
  for (const [tableName, table] of Object.entries(schema)) {
    const reserved = Object.keys(table.indexes).find((indexName) =>
      indexName.endsWith(INSTANCE_INDEX_SUFFIX),
    );
    if (reserved !== undefined) {
      throw new Error(
        `Index '${reserved}' of table '${tableName}' ends with the reserved suffix '${INSTANCE_INDEX_SUFFIX}'; rename it`,
      );
    }
  }
}

/**
 * Lists every physical index a table needs: `<name>__i` (led by the instance
 * field) for each declared index, `<name>` for cross-instance indexes, and the
 * instance field index itself.
 */
export function buildIndexCreations(
  table: TermJson,
  indexes: Record<string, IndexDefinition>,
): IndexCreation[] {
  const declared = Object.entries(indexes).flatMap(
    ([indexName, definition]) => {
      const instance = buildInstanceIndexCreation(table, indexName, definition);
      if (!definition.crossInstance) {
        return [instance];
      }
      return [instance, buildGlobalIndexCreation(table, indexName, definition)];
    },
  );
  const tenantIndex: IndexCreation = {
    name: TENANT_ID_FIELD,
    term: [TermType.INDEX_CREATE, [table, TENANT_ID_FIELD]],
  };
  return [...declared, tenantIndex];
}

export function buildInstanceScope(
  table: TermJson,
  tenantId: string,
): TermJson {
  return [TermType.GET_ALL, [table, tenantId], { index: TENANT_ID_FIELD }];
}

function warnedIndexNames(schemaId: string, tableName: string): Set<string> {
  const tables = warnedIndexes.get(schemaId) ?? new Map<string, Set<string>>();
  warnedIndexes.set(schemaId, tables);
  const indexNames = tables.get(tableName) ?? new Set<string>();
  tables.set(tableName, indexNames);
  return indexNames;
}

export function warnUnindexedCrossInstance(index: DeclaredIndex) {
  const indexNames = warnedIndexNames(index.schemaId, index.tableName);
  if (indexNames.has(index.indexName)) {
    return;
  }
  indexNames.add(index.indexName);
  Logger.Warn(
    `CROSS_INSTANCE query on index '${index.indexName}' of table '${index.schemaId}.${index.tableName}' runs without an index; declare the index with crossInstance: true to make it fast`,
  );
}

function buildIndexMatch(
  row: TermJson,
  index: DeclaredIndex,
  matches: TermBuilder,
): TermJson {
  const value = buildIndexValue(row, index.indexName, index.definition);
  if (!index.definition.multi) {
    return matches(value);
  }
  return [
    TermType.CONTAINS,
    [buildIndexEntries(value), buildFunction(matches)],
  ];
}

/**
 * Builds a filter predicate matching the entries a declared index would hold,
 * for cross-instance reads on an index that does not exist unprefixed.
 */
export function buildIndexScanPredicate(
  index: DeclaredIndex,
  matches: TermBuilder,
): TermJson {
  warnUnindexedCrossInstance(index);
  return buildFunction((row) => buildIndexMatch(row, index, matches));
}

/**
 * Streams the values a declared index would hold for each document, skipping
 * documents missing an indexed field and null entries, as the index does.
 */
export function buildIndexScanValues(
  source: TermJson,
  index: DeclaredIndex,
): TermJson {
  warnUnindexedCrossInstance(index);
  const { indexName, definition } = index;
  const indexed: TermJson = [
    TermType.HAS_FIELDS,
    [source, ...indexedFields(indexName, definition)],
  ];
  const readValue = (row: TermJson) =>
    buildIndexValue(row, indexName, definition);
  if (!definition.multi) {
    return [TermType.MAP, [indexed, buildFunction(readValue)]];
  }
  const entries: TermJson = [
    TermType.CONCAT_MAP,
    [indexed, buildFunction((row) => buildIndexEntries(readValue(row)))],
  ];
  const isPresent = buildFunction((entry) => [TermType.NE, [entry, null]]);
  return [TermType.FILTER, [entries, isPresent]];
}

/**
 * Translates a read on a declared index: scoped reads use `<name>__i`,
 * cross-instance reads use `<name>` when it exists and scan otherwise.
 */
export function buildIndexedRead(
  target: IndexedReadTarget,
  read: IndexedRead,
): TermJson {
  const { tenantId, definition } = target;
  if (tenantId !== undefined) {
    return read.lookup(target.table, {
      index: instanceIndexName(target.indexName),
      key: (value) => buildInstanceKey(tenantId, definition, value),
    });
  }
  if (definition.crossInstance) {
    return read.lookup(target.source, {
      index: target.indexName,
      key: (value) => value,
    });
  }
  return [
    TermType.FILTER,
    [target.source, buildIndexScanPredicate(target, read.matches)],
  ];
}
