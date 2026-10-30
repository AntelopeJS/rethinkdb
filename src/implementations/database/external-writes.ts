import { TermType } from "rethinkdb-ts/lib/proto/enums";
import {
  DuplicateKeyError,
  IsDuplicateKeyError,
} from "@antelopejs/interface-database";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";

import { GetOptions } from "../../config";
import { executeBounded, executeTermJson } from "../../connection";
import type {
  ExternalTable,
  FieldDescriptor,
  KeyClass,
} from "./external-descriptor";
import {
  Func,
  type KeyData,
  KeyDataTerm,
  KeyValue,
  ReadField,
} from "./external-read";
import { allocateArgNumber, IsText } from "./utils";

/** What went wrong with a write, in terms a caller can act on. */
type ExternalWriteErrorKind = "invalid" | "forbidden";

/** A write to an external table the database, or the adapter on its behalf, refused. */
class ExternalWriteError extends Error {
  public constructor(
    message: string,
    public readonly kind: ExternalWriteErrorKind,
    public readonly fields: string[] = [],
  ) {
    super(message);
    this.name = "ExternalWriteError";
  }
}

type WriteMode = "insert" | "update" | "replace";

/** A plain value of a payload, as data-api and the DMS send it. */
type PayloadValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | PayloadValue[]
  | PayloadObject;

interface PayloadObject {
  [field: string]: PayloadValue;
}

interface Payload {
  key?: TermJson;
  fields: Record<string, TermJson>;
  descriptors: FieldDescriptor[];
  removed: string[];
}

const ID_FIELD = "_id";
const DROPPED_KEYS = new Set(["_instance", "tenant_id"]);
const SCALAR_KINDS = new Set(["string", "number", "boolean", "date"]);
const PERMISSION_ERROR = /does not have the required `write` permission/;

const KEY_CONSTRUCTORS = new Map<unknown, KeyClass>([
  [String, "string"],
  [Number, "number"],
]);

const CONSTRUCTORS = new Map<string, unknown>([
  ["string", String],
  ["number", Number],
  ["boolean", Boolean],
  ["date", Date],
]);

/** A primitive value as text; undefined for null, documents and arrays. */
function Text(value: PayloadValue | TermJson): string | undefined {
  if (value === null || value === undefined || value instanceof Object) {
    return undefined;
  }
  return String(value);
}

function TimeOf(date: Date): TermJson {
  return {
    $reql_type$: "TIME",
    epoch_time: date.getTime() / 1000,
    timezone: "+00:00",
  };
}

/** A value as its declared kind writes it, or undefined when it is not of that kind. */
function Written(
  descriptor: FieldDescriptor,
  value: PayloadValue,
): TermJson | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  if (descriptor.kind === "date") {
    const date =
      value instanceof Date
        ? value
        : new Date(IsText(value) ? value : Number.NaN);
    return Number.isNaN(date.getTime()) ? undefined : TimeOf(date);
  }
  const fits = value.constructor === CONSTRUCTORS.get(descriptor.kind);
  const finite = descriptor.kind !== "number" || Number.isFinite(value);
  // SAFETY: the value's constructor is the declared kind's String, Number or Boolean.
  return fits && finite ? (value as TermJson) : undefined;
}

function Invalid(
  table: string,
  failures: [string, string][],
): ExternalWriteError {
  return new ExternalWriteError(
    failures
      .map(([field, reason]) => `Field '${field}' of ${table} ${reason}`)
      .join("; "),
    "invalid",
    failures.map(([field]) => field),
  );
}

function RequireKey(table: ExternalTable): KeyClass {
  if (!table.key) {
    throw new Error(
      `Table ${table.table} has primary keys of more than one type, so its rows cannot be written: it is read-only through this instance`,
    );
  }
  return table.key;
}

/** The key a payload names, through `_id` or the primary key field, which must agree. */
function KeyOf(
  table: ExternalTable,
  value: PayloadObject,
  failures: [string, string][],
): TermJson | undefined {
  const key = RequireKey(table);
  const byId =
    value[ID_FIELD] === undefined
      ? undefined
      : KeyValue(key, Text(value[ID_FIELD]) ?? "");
  const byField = KeyFieldTerm(
    Object.prototype.hasOwnProperty.call(value, table.primaryKey)
      ? value[table.primaryKey]
      : undefined,
  );
  for (const [field, term] of [
    [ID_FIELD, byId],
    [table.primaryKey, byField],
  ] as const) {
    if (term !== undefined && KeyClassOf(term) !== key) {
      failures.push([field, `expects a key of type ${key}`]);
    }
  }
  if (
    byId !== undefined &&
    byField !== undefined &&
    JSON.stringify(byId) !== JSON.stringify(byField)
  ) {
    failures.push([table.primaryKey, `names another row than _id`]);
  }
  return byId ?? byField;
}

/** A key field's value as a query term: arrays, at any depth, built as such, never read as terms. */
function KeyFieldTerm(value: PayloadValue): TermJson | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return KeyDataTerm(value) ?? null;
}

/** The key class a key term is of, as the table's primary index ends name them. */
function KeyClassOf(term: TermJson): KeyClass | undefined {
  if (Array.isArray(term)) {
    return term[0] === TermType.MAKE_ARRAY ? "array" : undefined;
  }
  return KEY_CONSTRUCTORS.get(term?.constructor);
}

/** A key term as the plain value the table stores. */
function KeyData(term: TermJson): TermJson {
  return Array.isArray(term) && term[0] === TermType.MAKE_ARRAY
    ? term[1].map(KeyData)
    : term;
}

function Split(
  table: ExternalTable,
  mode: WriteMode,
  value: PayloadObject,
): Payload {
  const failures: [string, string][] = [];
  const payload: Payload = {
    key: KeyOf(table, value, failures),
    fields: {},
    descriptors: [],
    removed: [],
  };
  for (const [name, field] of Object.entries(value)) {
    const descriptor = table.fields[name];
    if (
      name === ID_FIELD ||
      name === table.primaryKey ||
      DROPPED_KEYS.has(name)
    ) {
      continue;
    }
    if (!descriptor) {
      failures.push([
        name,
        "is not a declared field: only declared fields of an external table can be written",
      ]);
    } else if (!SCALAR_KINDS.has(descriptor.kind)) {
      if (mode === "insert" && field !== undefined) {
        failures.push([
          name,
          `is read-only: a ${descriptor.kind} value comes back altered by a read, so it is never written`,
        ]);
      }
    } else if (!(mode === "insert" && field === undefined)) {
      const written = Written(descriptor, field);
      if (written === undefined) {
        failures.push([name, `expects a ${descriptor.kind}`]);
      }
      payload.fields[name] = written ?? null;
      payload.descriptors.push(descriptor);
    }
  }
  if (mode === "replace") {
    payload.removed = Object.values(table.fields)
      .filter(
        (descriptor) =>
          SCALAR_KINDS.has(descriptor.kind) &&
          descriptor.field !== table.primaryKey &&
          !Object.prototype.hasOwnProperty.call(value, descriptor.field),
      )
      .map((descriptor) => descriptor.field);
  }
  if (failures.length > 0) {
    throw Invalid(table.table, failures);
  }
  return payload;
}

/**
 * The write-back guard: only the fields whose read differs from the incoming value are written, so
 * a field a read answered keeps its stored value, or stays absent.
 */
function GuardedUpdate(payload: Payload): TermJson {
  return Func((row) => {
    const changed: TermJson[] = payload.descriptors.map((descriptor) => {
      const incoming = payload.fields[descriptor.field];
      return [
        TermType.BRANCH,
        [
          [TermType.EQ, [ReadField(row, descriptor), incoming]],
          null,
          [TermType.MAKE_ARRAY, [descriptor.field, incoming]],
        ],
      ];
    });
    const kept: TermJson = [
      TermType.FILTER,
      [
        [TermType.MAKE_ARRAY, changed],
        Func((pair) => [TermType.NE, [pair, null]]),
      ],
    ];
    return [TermType.COERCE_TO, [kept, "OBJECT"]];
  });
}

/** The target restricted to the row the payload's key names, when it names one. */
function KeyedTarget(
  table: ExternalTable,
  target: TermJson,
  key: TermJson | undefined,
): TermJson {
  if (key === undefined) {
    return target;
  }
  const stream =
    Array.isArray(target) && target[0] === TermType.GET
      ? [TermType.GET_ALL, target[1]]
      : target;
  return [
    TermType.FILTER,
    [
      stream,
      Func((row) => [
        TermType.EQ,
        [[TermType.BRACKET, [row, table.primaryKey]], key],
      ]),
    ],
  ];
}

/** Whether the new row sends a field, null included, which `hasFields` would not count. */
function Sends(incoming: TermJson, field: TermJson): TermJson {
  return [TermType.CONTAINS, [[TermType.KEYS, [incoming]], field]];
}

/**
 * The conflict function of an insert onto an existing row: the stored row, with each declared
 * scalar field the new row sends written only where its read differs, as an update's guard does.
 * On `replace`, the declared scalar fields the new row leaves out are removed. Undeclared fields
 * always stay.
 */
function ConflictMerge(
  table: ExternalTable,
  conflict: "update" | "replace",
): TermJson {
  const [oldId, newId] = [allocateArgNumber(), allocateArgNumber()];
  const old: TermJson = [TermType.VAR, [oldId]];
  const incoming: TermJson = [TermType.VAR, [newId]];
  const declared = Object.values(table.fields).filter(
    (descriptor) =>
      SCALAR_KINDS.has(descriptor.kind) &&
      descriptor.field !== table.primaryKey,
  );
  const changed: TermJson[] = declared.map((descriptor) => {
    const sent: TermJson = [TermType.BRACKET, [incoming, descriptor.field]];
    return [
      TermType.BRANCH,
      [
        [
          TermType.AND,
          [
            Sends(incoming, descriptor.field),
            [TermType.NE, [ReadField(old, descriptor), sent]],
          ],
        ],
        [TermType.MAKE_ARRAY, [descriptor.field, sent]],
        null,
      ],
    ];
  });
  const changes: TermJson = [
    TermType.COERCE_TO,
    [
      [
        TermType.FILTER,
        [
          [TermType.MAKE_ARRAY, changed],
          Func((pair) => [TermType.NE, [pair, null]]),
        ],
      ],
      "OBJECT",
    ],
  ];
  const left: TermJson = [
    TermType.FILTER,
    [
      [TermType.MAKE_ARRAY, declared.map((descriptor) => descriptor.field)],
      Func((field) => [TermType.NOT, [Sends(incoming, field)]]),
    ],
  ];
  const base: TermJson =
    conflict === "replace"
      ? [TermType.WITHOUT, [old, [TermType.ARGS, [left]]]]
      : old;
  return [
    TermType.FUNC,
    [
      [TermType.MAKE_ARRAY, [allocateArgNumber(), oldId, newId]],
      [TermType.MERGE, [base, changes]],
    ],
  ];
}

function TableTerm(database: string, table: ExternalTable): TermJson {
  return [TermType.TABLE, [[TermType.DB, [database]], table.table]];
}

async function Insert(
  database: string,
  table: ExternalTable,
  values: PayloadObject[],
  conflict?: "update" | "replace",
): Promise<string[]> {
  const key = RequireKey(table);
  const documents = values.map((value) => {
    const payload = Split(table, "insert", value);
    if (payload.key === undefined && !table.generatesKeys) {
      throw Invalid(table.table, [
        [ID_FIELD, `is required: keys of type ${key} are not generated`],
      ]);
    }
    return payload.key === undefined
      ? payload.fields
      : { ...payload.fields, [table.primaryKey]: payload.key };
  });
  const options = conflict ? { conflict: ConflictMerge(table, conflict) } : {};
  const result = await executeTermJson([
    TermType.INSERT,
    [TableTerm(database, table), [TermType.MAKE_ARRAY, documents]],
    options,
  ]).catch((error: Error) => {
    throw IsDuplicateKeyError(error)
      ? new DuplicateKeyError(table.primaryKey, [table.primaryKey])
      : error;
  });
  const generated: TermJson[] = [...(result?.generated_keys ?? [])];
  return documents.map((document) => {
    const stored = document[table.primaryKey] ?? generated.shift() ?? null;
    return key === "array"
      ? JSON.stringify(KeyData(stored))
      : (Text(stored) ?? "");
  });
}

/** One write on an external table, as `SelectionQuery` hands it over. */
export interface ExternalWrite {
  kind: string;
  value: PayloadObject | PayloadObject[];
  target: TermJson;
  conflict?: "update" | "replace";
}

const BY_KEY = new Set<TermJson>([TermType.GET, TermType.GET_ALL]);

/**
 * The rows a selection names, pinned by their primary keys, so a second update reaches the rows
 * the first one changed even when it moved them out of the selection.
 */
async function Pinned(
  database: string,
  table: ExternalTable,
  target: TermJson,
): Promise<TermJson> {
  const byPrimaryKey =
    Array.isArray(target) &&
    BY_KEY.has(target[0]) &&
    target[2]?.index === undefined;
  if (byPrimaryKey) {
    return target;
  }
  const read: TermJson = [
    TermType.MAP,
    [target, Func((row) => [TermType.BRACKET, [row, table.primaryKey]])],
  ];
  const timeoutMs = GetOptions().statementTimeoutMs;
  const keys: KeyData[] =
    timeoutMs === undefined
      ? await executeTermJson(read)
      : await executeBounded(read, timeoutMs);
  if (keys.length === 0) {
    return target;
  }
  return [
    TermType.GET_ALL,
    [
      TableTerm(database, table),
      ...keys.flatMap((key) => KeyDataTerm(key) ?? []),
    ],
  ];
}

async function Run(
  database: string,
  table: ExternalTable,
  write: ExternalWrite,
): Promise<number | string[]> {
  if (write.kind === "insert") {
    return Insert(database, table, [write.value].flat(), write.conflict);
  }
  if (write.kind === "delete") {
    return (
      (await executeTermJson([TermType.DELETE, [write.target]]))?.deleted ?? 0
    );
  }
  const [value] = [write.value].flat();
  const payload = Split(
    table,
    write.kind === "replace" ? "replace" : "update",
    value,
  );
  const selected =
    payload.removed.length > 0
      ? await Pinned(database, table, write.target)
      : write.target;
  const target = KeyedTarget(table, selected, payload.key);
  const updated = await executeTermJson([
    TermType.UPDATE,
    [target, GuardedUpdate(payload)],
  ]);
  if (payload.removed.length === 0) {
    return updated?.replaced ?? 0;
  }
  const removals = Object.fromEntries(
    payload.removed.map((field) => [field, [TermType.LITERAL, []]]),
  );
  const removed = await executeTermJson([TermType.UPDATE, [target, removals]]);
  return Math.max(updated?.replaced ?? 0, removed?.replaced ?? 0);
}

/**
 * Runs an insert, update, replace or delete on an external table: declared scalar fields only,
 * through the write-back guard, never `replace()`, which would drop undeclared fields.
 */
export async function RunExternalWrite(
  database: string,
  table: ExternalTable,
  write: ExternalWrite,
): Promise<number | string[]> {
  RequireKey(table);
  try {
    return await Run(database, table, write);
  } catch (error) {
    if (error instanceof Error && PERMISSION_ERROR.test(error.message)) {
      throw new ExternalWriteError(
        `The connected account may not write to table ${table.table}`,
        "forbidden",
      );
    }
    throw error;
  }
}
