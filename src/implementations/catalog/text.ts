import { IsObject } from "../database/utils";

/** A value a sampled row holds, as the driver answers it. */
export type RowValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | RowValue[]
  | { [field: string]: RowValue };

/** A stored value as text: a date in ISO form, an array or a document as JSON. */
export function TextOf(value: RowValue): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return IsObject(value) ? JSON.stringify(value) : String(value);
}
