import assert from "node:assert";
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
) {
  assert(IsQueryStage(stage, name), `Expected a ${name} stage`);
  return stage;
}

/**
 * Tells whether an `update` argument records a function of the row rather than a document: an
 * object whose `stage` reads "func", which is how the adapter tells them apart.
 */
export function IsUpdateFunction(
  value: QueryStage<"update">["args"][0],
): value is QueryStage<"func"> {
  return value instanceof Object && "stage" in value && value.stage === "func";
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

let nextArgNumber = 0;
export function allocateArgNumber() {
  return nextArgNumber++;
}

export class DecodingContext {
  public args: Record<number, ArgumentProvider> = {};
}
