import { TermType } from "rethinkdb-ts/lib/proto/enums";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";

import { allocateArgNumber, IsList, IsNumber, IsObject, IsText } from "./utils";
import {
  type DeclaredKind,
  type ExternalTable,
  type FieldDescriptor,
  type KeyClass,
  READ_TYPES,
} from "./external-descriptor";

const NUMBER_TEXT = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const ID_FIELD = "_id";
const ARRAY_TYPE = "ARRAY";

/** A one-argument ReQL function whose body is built from its argument. */
export function Func(body: (argument: TermJson) => TermJson): TermJson {
  const argId = allocateArgNumber();
  return [
    TermType.FUNC,
    [[TermType.MAKE_ARRAY, [argId]], body([TermType.VAR, [argId]])],
  ];
}

function Field(row: TermJson, field: string): TermJson {
  return [TermType.DEFAULT, [[TermType.BRACKET, [row, field]], null]];
}

function Typed(value: TermJson, type: string | undefined): TermJson {
  return type === undefined
    ? value
    : [
        TermType.BRANCH,
        [[TermType.EQ, [[TermType.TYPE_OF, [value]], type]], value, null],
      ];
}

function ReadValue(
  kind: DeclaredKind,
  value: TermJson,
  element?: DeclaredKind,
): TermJson {
  if (kind !== "array" || !element) {
    return Typed(value, READ_TYPES[kind]);
  }
  return [
    TermType.BRANCH,
    [
      [TermType.EQ, [[TermType.TYPE_OF, [value]], ARRAY_TYPE]],
      [TermType.MAP, [value, Func((item) => ReadValue(element, item))]],
      null,
    ],
  ];
}

/** The expression a declared field reads as, from a row. */
export function ReadField(
  row: TermJson,
  descriptor: FieldDescriptor,
): TermJson {
  return ReadValue(
    descriptor.kind,
    Field(row, descriptor.field),
    descriptor.element,
  );
}

const KEY_RENDERINGS: Record<KeyClass, (key: TermJson) => TermJson> = {
  string: (key) => key,
  number: (key) => [TermType.COERCE_TO, [key, "STRING"]],
  array: (key) => [TermType.TO_JSON_STRING, [key]],
};

/**
 * The row a declaration reads, from a stored row: `_id` rendered from the primary key, each
 * declared field as its kind or null, and every undeclared field dropped.
 */
function NormalizedRow(table: ExternalTable, row: TermJson): TermJson {
  const normalized: Record<string, TermJson> = {};
  if (table.key) {
    normalized[ID_FIELD] = KEY_RENDERINGS[table.key]([
      TermType.BRACKET,
      [row, table.primaryKey],
    ]);
  }
  for (const descriptor of Object.values(table.fields)) {
    normalized[descriptor.field] = ReadField(row, descriptor);
  }
  return normalized;
}

/** Normalizes a selection: each row of a stream, or the one row of a `get`, null kept. */
export function Normalized(
  table: ExternalTable,
  term: TermJson,
  singleElement: boolean,
): TermJson {
  const normalize = Func((row) => NormalizedRow(table, row));
  if (!singleElement) {
    return [TermType.MAP, [term, normalize]];
  }
  return [
    TermType.FUNCALL,
    [
      Func((row) => [
        TermType.BRANCH,
        [[TermType.EQ, [row, null]], null, NormalizedRow(table, row)],
      ]),
      term,
    ],
  ];
}

/** A key's stored data, or whatever a text or a payload claims it to be. */
export type KeyData =
  | string
  | number
  | boolean
  | null
  | undefined
  | Date
  | KeyData[]
  | { [field: string]: KeyData };

/** Whether `value` is key data: a primitive, null, undefined, a date, or a list or object of key data. */
export function IsKeyData(value: unknown): value is KeyData {
  if (IsList(value)) {
    return value.every(IsKeyData);
  }
  if (value instanceof Date) {
    return true;
  }
  if (IsObject(value)) {
    return Object.values(value).every(IsKeyData);
  }
  return (
    value === null ||
    ["string", "number", "boolean", "undefined"].includes(typeof value)
  );
}

/**
 * A key's data as a term: each array, at any depth, built as one, so no part of it is ever read as
 * a term of its own; undefined for anything a key cannot hold.
 */
export function KeyDataTerm(value: KeyData): TermJson | undefined {
  if (Array.isArray(value)) {
    const elements = value.map(KeyDataTerm);
    return elements.every((element) => element !== undefined)
      ? [TermType.MAKE_ARRAY, elements]
      : undefined;
  }
  return IsText(value) || IsNumber(value) ? value : undefined;
}

function ParseArrayKey(text: string): TermJson {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) && IsKeyData(parsed)
      ? (KeyDataTerm(parsed) ?? text)
      : text;
  } catch {
    return text;
  }
}

/**
 * The primary key a rendered key addresses. Text that does not parse as the key's type stays
 * text, which no key of another type equals: `get` answers not found.
 */
export function KeyValue(key: KeyClass, text: string): TermJson {
  if (key === "number") {
    return NUMBER_TEXT.test(text) ? Number(text) : text;
  }
  return key === "array" ? ParseArrayKey(text) : text;
}

/** A runtime key converted on the server the same way, leaving it as it was when it does not parse. */
export function KeyExpression(key: KeyClass, value: TermJson): TermJson {
  if (key === "string") {
    return value;
  }
  const to =
    key === "number"
      ? [TermType.COERCE_TO, [value, "NUMBER"]]
      : [TermType.JSON, [value]];
  return [
    TermType.BRANCH,
    [
      [TermType.EQ, [[TermType.TYPE_OF, [value]], "STRING"]],
      [TermType.DEFAULT, [to, value]],
      value,
    ],
  ];
}
