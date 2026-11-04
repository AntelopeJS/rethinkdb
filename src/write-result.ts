import { TermType } from "rethinkdb-ts/lib/proto/enums";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import { DuplicateKeyError } from "@antelopejs/interface-database";

import {
  IsNumber,
  IsObject,
  IsText,
  IsTextList,
  PRIMARY_KEY_FIELD,
} from "./implementations/database/utils";

const WRITE_TERMS = new Set<unknown>([
  TermType.INSERT,
  TermType.UPDATE,
  TermType.REPLACE,
  TermType.DELETE,
]);

const DUPLICATE_PRIMARY_KEY_PATTERN = /^Duplicate primary key/;

/** The counters RethinkDB answers a write with, and its first error and generated keys when it has them. */
export interface WriteResult {
  inserted: number;
  replaced: number;
  unchanged: number;
  errors: number;
  deleted: number;
  skipped: number;
  first_error?: string;
  generated_keys?: string[];
}

/** Whether `value` is a write result: its six counters numbers, its first error text, its generated keys a list of text. */
export function IsWriteResult(value: unknown): value is WriteResult {
  return (
    IsObject(value) &&
    "inserted" in value &&
    IsNumber(value.inserted) &&
    "replaced" in value &&
    IsNumber(value.replaced) &&
    "unchanged" in value &&
    IsNumber(value.unchanged) &&
    "errors" in value &&
    IsNumber(value.errors) &&
    "deleted" in value &&
    IsNumber(value.deleted) &&
    "skipped" in value &&
    IsNumber(value.skipped) &&
    (!("first_error" in value) || IsText(value.first_error)) &&
    (!("generated_keys" in value) || IsTextList(value.generated_keys))
  );
}

function toWriteError(firstError: string | undefined): Error {
  if (firstError && DUPLICATE_PRIMARY_KEY_PATTERN.test(firstError)) {
    return new DuplicateKeyError(PRIMARY_KEY_FIELD, [PRIMARY_KEY_FIELD]);
  }
  return new Error(firstError ?? "RethinkDB write failed");
}

/**
 * Throws when a write result reports row errors, as a `DuplicateKeyError` on
 * `_id` when the first one is a primary key collision.
 *
 * RethinkDB reports a primary key collision as a per-row write error, not as
 * a query error: `errors > 0` with `Duplicate primary key` leading
 * `first_error`.
 */
export function validateWriteResult(
  term: TermJson,
  result: WriteResult | undefined,
): void {
  if (!Array.isArray(term) || !WRITE_TERMS.has(term[0])) {
    return;
  }
  if (result !== undefined && result.errors > 0) {
    throw toWriteError(result.first_error);
  }
}
