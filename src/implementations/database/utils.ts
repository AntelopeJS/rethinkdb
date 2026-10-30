import type { StagedObject } from "@antelopejs/interface-database/common";

export const TENANT_ID_FIELD = "tenant_id";
export const PRIMARY_KEY_FIELD = "_id";
export const INSTANCE_REGISTRY_TABLE = "__instances__";
export const INSTANCE_REGISTRY_FIELD = "instance_id";

export type QueryStage = StagedObject["stages"][number];

export type ArgumentProvider = (subQuery: QueryStage[]) => any;

/** Whether `value` is a non-null object, arrays included. */
export function IsObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

/** Whether `value` is made by the `String` constructor: a text as the driver and JSON hold one. */
export function IsText(value: unknown): value is string {
  return value !== null && value !== undefined && value.constructor === String;
}

/** Whether `value` is made by the `Number` constructor: a number as the driver and JSON hold one. */
export function IsNumber(value: unknown): value is number {
  return value !== null && value !== undefined && value.constructor === Number;
}

let nextArgNumber = 0;
export function allocateArgNumber() {
  return nextArgNumber++;
}

export class DecodingContext {
  public args: Record<number, ArgumentProvider> = {};
}
