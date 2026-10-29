import { TermType } from "rethinkdb-ts/lib/proto/enums";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import { DuplicateKeyError } from "@antelopejs/interface-database";

import { PRIMARY_KEY_FIELD } from "./implementations/database/utils";

const WRITE_TERMS = new Set([
  TermType.INSERT,
  TermType.UPDATE,
  TermType.REPLACE,
  TermType.DELETE,
]);

const DUPLICATE_PRIMARY_KEY_PATTERN = /^Duplicate primary key/;

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
export function validateWriteResult(term: TermJson, result: any): void {
  if (!Array.isArray(term) || !WRITE_TERMS.has(term[0])) {
    return;
  }
  if (result?.errors > 0) {
    throw toWriteError(result.first_error);
  }
}
