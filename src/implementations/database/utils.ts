import assert from "node:assert";
import { TermType } from "rethinkdb-ts/lib/proto/enums";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import {
  IsQueryStage,
  type QueryStage,
  type QueryStageName,
} from "@antelopejs/interface-database/common";

export const TENANT_ID_FIELD = "tenant_id";
export const PRIMARY_KEY_FIELD = "_id";
export const INSTANCE_REGISTRY_TABLE = "__instances__";
export const INSTANCE_REGISTRY_FIELD = "instance_id";

export type { QueryStage };

/** The stage a handler registered under `name` runs for, typed by that name. */
export function StageNamed<Name extends QueryStageName>(
  stage: QueryStage | undefined,
  name: Name,
): Extract<QueryStage, { stage: Name }> {
  assert(IsQueryStage(stage, name), `Expected a ${name} stage`);
  return stage;
}

/**
 * Tells whether an `update` argument records a function of the row rather than a document: the
 * `func` stage the builder records, whose `stage` reads "func" and whose `args` pair the
 * parameter ids with the body. A document holding a field `stage` set to "func" without that
 * pair stays a document.
 */
export function IsUpdateFunction(
  value: QueryStage<"update">["args"][0],
): value is QueryStage<"func"> {
  if (!(value instanceof Object) || !("stage" in value) || !("args" in value)) {
    return false;
  }
  const { stage, args } = value;
  return (
    stage === "func" &&
    Array.isArray(args) &&
    args.length === 2 &&
    Array.isArray(args[0]) &&
    args[0].every((id) => Number.isInteger(id))
  );
}

export type ArgumentProvider = (subQuery: QueryStage[]) => TermJson;

/** Whether `value` is a non-null object, arrays included. */
export function IsObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

/** Whether `value` is a primitive string. */
export function IsText(value: unknown): value is string {
  return typeof value === "string";
}

/** Whether `value` is a primitive number. */
export function IsNumber(value: unknown): value is number {
  return typeof value === "number";
}

/** Whether `value` is a list. */
export function IsList(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** Whether `value` is a term: null, a primitive string, number or boolean, or an object. */
export function IsTermJson(value: unknown): value is TermJson {
  return (
    value === null ||
    ["string", "number", "boolean", "object"].includes(typeof value)
  );
}

/** Whether `value` is a list of primitive strings. */
export function IsTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(IsText);
}

/** A term reading `path` in `row`. Each dot steps into a nested object, so `"a.b"` reads `b` inside `a`. */
export function ReadPath(row: TermJson, path: string): TermJson {
  return path
    .split(".")
    .reduce<TermJson>((term, key) => [TermType.BRACKET, [term, key]], row);
}

/** The keys a lookup's local field holds: each element of a list, or the field itself. */
export function LookupKeys(local: TermJson): TermJson {
  return [
    TermType.BRANCH,
    [
      [TermType.EQ, [[TermType.TYPE_OF, [local]], "ARRAY"]],
      local,
      [TermType.MAKE_ARRAY, [local]],
    ],
  ];
}

/** A `getAll` term reading every key of `keys`, a term answering a list. */
export function GetAllKeys(
  source: TermJson,
  keys: TermJson,
  options?: { index: string },
): TermJson {
  const args: TermJson = [source, [TermType.ARGS, [keys]]];
  return options ? [TermType.GET_ALL, args, options] : [TermType.GET_ALL, args];
}

let nextArgNumber = 0;
export function allocateArgNumber() {
  return nextArgNumber++;
}

export class DecodingContext {
  public args: Record<number, ArgumentProvider> = {};
}
