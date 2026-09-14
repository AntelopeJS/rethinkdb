import { TermType } from "rethinkdb-ts/lib/proto/enums";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";

const WRITE_TERMS = new Set([
  TermType.INSERT,
  TermType.UPDATE,
  TermType.REPLACE,
  TermType.DELETE,
]);

export function validateWriteResult(term: TermJson, result: any): void {
  if (!Array.isArray(term) || !WRITE_TERMS.has(term[0])) {
    return;
  }
  if (result?.errors > 0) {
    throw new Error(result.first_error ?? "RethinkDB write failed");
  }
}
