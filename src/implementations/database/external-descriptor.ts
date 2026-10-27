import type {
  FieldType,
  TableDefinition,
} from "@antelopejs/interface-database/schema";

import type { TableFacts } from "./external-probe";

/** A declaration's kind, as `TableDefinition.fields` spells it. */
export type DeclaredKind =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "object"
  | "array"
  | "any";

/** The ReQL type every primary key of a keyed table has. */
export type KeyClass = "string" | "number" | "array";

export interface FieldDescriptor {
  field: string;
  kind: DeclaredKind;
  /** The kind of each element of an array declaration. */
  element?: DeclaredKind;
}

/**
 * What a declared table of an external instance reads: the table of the configured database under
 * the table's own name. No `key` means its primary keys span more than one type, and its rows
 * answer no `_id`.
 */
export interface ExternalTable {
  table: string;
  primaryKey: string;
  key?: KeyClass;
  /** Whether an insert without a key lets the server generate a uuid. */
  generatesKeys: boolean;
  /** The secondary indexes that read plain fields, by name, with those fields. */
  indexes: Record<string, string[]>;
  /** The names of those indexes that are multi indexes, holding one entry per array element. */
  multiIndexes: string[];
  fields: Record<string, FieldDescriptor>;
}

export interface DescribedTable {
  table: ExternalTable;
  warnings: string[];
  notices: string[];
}

export interface DeclaredTable {
  schemaId: string;
  tableId: string;
  table: TableDefinition;
}

const ID_FIELD = "_id";
const ARRAY_SUFFIX = "[]";
const PERCENT = 100;
const NULL_TYPE = "NULL";

const SCALAR_KINDS = new Map<string, DeclaredKind>([
  ["string", "string"],
  ["number", "number"],
  ["boolean", "boolean"],
  ["date", "date"],
  ["object", "object"],
  ["any", "any"],
]);

/** The ReQL type each declared kind reads; any other value reads as null. */
export const READ_TYPES: Record<DeclaredKind, string | undefined> = {
  string: "STRING",
  number: "NUMBER",
  boolean: "BOOL",
  date: "PTYPE<TIME>",
  object: "OBJECT",
  array: "ARRAY",
  any: undefined,
};

const KEY_CLASSES = new Map<string, KeyClass>([
  ["STRING", "string"],
  ["NUMBER", "number"],
  ["ARRAY", "array"],
]);

const SUPPORTED_TOKENS = [...SCALAR_KINDS.keys()].join(", ");

function PathOf(declared: DeclaredTable, field?: string): string {
  const table = `${declared.schemaId}.${declared.tableId}`;
  return field === undefined ? table : `${table}.${field}`;
}

function ParseToken(token: string, path: string): DeclaredKind {
  const normalized = token.trim().toLowerCase();
  if (normalized.endsWith(ARRAY_SUFFIX)) {
    ParseToken(normalized.slice(0, -ARRAY_SUFFIX.length), path);
    return "array";
  }
  const kind = SCALAR_KINDS.get(normalized);
  if (!kind) {
    throw new Error(
      `Unsupported field type '${token}' for '${path}'. Supported: ${SUPPORTED_TOKENS}, optionally suffixed with [], a nested record, or an io-ts codec`,
    );
  }
  return kind;
}

function IsCodec(type: FieldType): boolean {
  return (
    type instanceof Object &&
    "decode" in type &&
    "encode" in type &&
    "is" in type
  );
}

function DeclaredKindOf(type: FieldType, path: string): DeclaredKind {
  if (Array.isArray(type)) {
    return "array";
  }
  if (IsCodec(type)) {
    return "any";
  }
  return type instanceof Object ? "object" : ParseToken(String(type), path);
}

function ElementKindOf(
  type: FieldType,
  path: string,
): DeclaredKind | undefined {
  if (Array.isArray(type)) {
    return type.length > 0 ? DeclaredKindOf(type[0], path) : undefined;
  }
  if (type instanceof Object) {
    return undefined;
  }
  const token = String(type).trim().toLowerCase();
  return token.endsWith(ARRAY_SUFFIX)
    ? ParseToken(token.slice(0, -ARRAY_SUFFIX.length), path)
    : undefined;
}

function LossyWarning(
  declared: DeclaredTable,
  facts: TableFacts,
  descriptor: FieldDescriptor,
): string | undefined {
  const reads = READ_TYPES[descriptor.kind];
  const values = facts.sample.filter(
    (entry) => entry.field === descriptor.field && entry.type !== NULL_TYPE,
  );
  const unread = values.filter(
    (entry) => reads !== undefined && entry.type !== reads,
  );
  const count = unread.reduce((sum, entry) => sum + entry.count, 0);
  if (count === 0) {
    return undefined;
  }
  const total = values.reduce((sum, entry) => sum + entry.count, 0);
  const share = ((count / total) * PERCENT).toFixed(1);
  const types = unread.map((entry) => entry.type).join(", ");
  return `Field '${PathOf(declared, descriptor.field)}' is declared ${descriptor.kind}, but ${count} of ${total} sampled values (${share}%) are ${types}, which read as null`;
}

interface KeyFinding {
  key?: KeyClass;
  reason?: string;
}

/** The key type class of a table from its primary index ends, or why it has none. */
export function KeyOf(facts: Pick<TableFacts, "ends">): KeyFinding {
  if (!facts.ends) {
    return { key: "string" };
  }
  const [first, last] = facts.ends;
  const key = KEY_CLASSES.get(first);
  return key && first === last
    ? { key }
    : {
        reason: `its primary keys range from ${first} to ${last}, more than one type`,
      };
}

function UnservedIndexWarnings(
  declared: DeclaredTable,
  facts: TableFacts,
): string[] {
  return Object.entries(declared.table.indexes ?? {})
    .map(([indexId, index]) => ({ indexId, wanted: index.fields ?? [indexId] }))
    .filter(
      ({ wanted }) =>
        !(wanted.length === 1 && wanted[0] === facts.primaryKey) &&
        !facts.indexes.some(
          (served) => served.fields.join(",") === wanted.join(","),
        ),
    )
    .map(
      ({ indexId, wanted }) =>
        `Index '${indexId}' on '${PathOf(declared)}' is declared, but table ${facts.name} has no index over (${wanted.join(", ")}): queries by it stay correct, and may be slow`,
    );
}

/**
 * Builds a declared table's descriptor from what the probe read, with nothing created: the key
 * type from the primary index ends, and per declared field its kind. A declaration the table
 * cannot honour throws, naming it; a lossy reading or a missing index is a warning.
 */
export function DescribeTable(
  declared: DeclaredTable,
  facts: TableFacts,
): DescribedTable {
  const warnings: string[] = [];
  const notices: string[] = [];
  const finding = KeyOf(facts);
  if (!finding.key) {
    if (ID_FIELD in (declared.table.fields ?? {})) {
      throw new Error(
        `Field '${PathOf(declared, ID_FIELD)}' is declared, but table ${facts.name} has no usable _id: ${finding.reason}; remove it`,
      );
    }
    notices.push(
      `Table ${facts.name} answers no _id for '${PathOf(declared)}', since ${finding.reason}: it can be queried, but not read by key`,
    );
  }
  const fields: Record<string, FieldDescriptor> = {};
  for (const [field, type] of Object.entries(declared.table.fields ?? {})) {
    if (field === ID_FIELD) {
      continue;
    }
    const path = PathOf(declared, field);
    const descriptor = {
      field,
      kind: DeclaredKindOf(type, path),
      element: ElementKindOf(type, path),
    };
    const lossy = LossyWarning(declared, facts, descriptor);
    if (lossy) {
      warnings.push(lossy);
    }
    fields[field] = descriptor;
  }
  warnings.push(...UnservedIndexWarnings(declared, facts));
  return {
    table: {
      table: facts.name,
      primaryKey: facts.primaryKey,
      key: finding.key,
      generatesKeys: finding.key === "string" && facts.uuidKeys,
      indexes: Object.fromEntries(
        facts.indexes
          .filter((index) => index.fields.length > 0)
          .map((index) => [index.name, index.fields]),
      ),
      multiIndexes: facts.indexes
        .filter((index) => index.multi)
        .map((index) => index.name),
      fields,
    },
    warnings,
    notices,
  };
}
