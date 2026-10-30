import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import type { StagedObject } from "@antelopejs/interface-database/common";

export const TENANT_ID_FIELD = "tenant_id";
export const PRIMARY_KEY_FIELD = "_id";
export const INSTANCE_REGISTRY_TABLE = "__instances__";
export const INSTANCE_REGISTRY_FIELD = "instance_id";

export type QueryStage = StagedObject["stages"][number];

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
