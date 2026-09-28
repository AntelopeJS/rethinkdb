import { TermType } from "rethinkdb-ts/lib/proto/enums";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import type { IndexDefinition } from "@antelopejs/interface-database/schema";

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

export interface IndexedReadTarget {
  schemaId: string;
  tableName: string;
  indexName: string;
  definition: IndexDefinition;
  table: TermJson;
  source: TermJson;
  tenantId?: string;
}

const warnedIndexes = new Set<string>();

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

export function warnUnindexedCrossInstance(
  schemaId: string,
  tableName: string,
  indexName: string,
) {
  const key = JSON.stringify([schemaId, tableName, indexName]);
  if (warnedIndexes.has(key)) {
    return;
  }
  warnedIndexes.add(key);
  Logger.Warn(
    `CROSS_INSTANCE query on index '${indexName}' of table '${schemaId}.${tableName}' runs without an index; declare the index with crossInstance: true to make it fast`,
  );
}

function buildIndexMatch(
  row: TermJson,
  target: IndexedReadTarget,
  matches: TermBuilder,
): TermJson {
  const value = buildIndexValue(row, target.indexName, target.definition);
  if (!target.definition.multi) {
    return matches(value);
  }
  return [
    TermType.CONTAINS,
    [buildIndexEntries(value), buildFunction(matches)],
  ];
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
  warnUnindexedCrossInstance(
    target.schemaId,
    target.tableName,
    target.indexName,
  );
  const predicate = buildFunction((row) =>
    buildIndexMatch(row, target, read.matches),
  );
  return [TermType.FILTER, [target.source, predicate]];
}
