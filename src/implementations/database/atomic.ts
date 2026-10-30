import assert from "node:assert";
import { r, RethinkDBErrorType } from "rethinkdb-ts";
import { TermType } from "rethinkdb-ts/lib/proto/enums";
import { isRethinkDBError } from "rethinkdb-ts/lib/error/error";
import { isQuery } from "rethinkdb-ts/lib/query-builder/query";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import {
  type AtomicEqualityValue,
  type AtomicMutation,
  type AtomicMutationOutcome,
  type MissingRevision,
  ValidateAtomicMutation,
} from "@antelopejs/interface-database/atomic";

import { executeTermJson } from "../../connection";
import { IsWriteResult, type WriteResult } from "../../write-result";
import { allocateArgNumber, TENANT_ID_FIELD } from "./utils";

const DEFINITIVE_ERRORS = new Set([
  RethinkDBErrorType.AUTH,
  RethinkDBErrorType.PARSE,
  RethinkDBErrorType.ARITY,
  RethinkDBErrorType.QUERY_LOGIC,
  RethinkDBErrorType.NON_EXISTENCE,
  RethinkDBErrorType.PERMISSION_ERROR,
]);
const WRITE_COUNTS = ["replaced", "deleted", "unchanged", "skipped"] as const;

function compiledTerm(value: Parameters<typeof r.expr>[0]): TermJson {
  const datum = r.expr(value);
  assert(isQuery(datum), "r.expr answered no query");
  return datum.term;
}

function isRevision(expected: string | MissingRevision): expected is string {
  return typeof expected === "string";
}

export async function runAtomicMutation<T>(
  table: TermJson,
  tenantId: string,
  key: string,
  request: AtomicMutation<T>,
): Promise<AtomicMutationOutcome> {
  ValidateAtomicMutation(key, request, [TENANT_ID_FIELD]);
  const term = buildAtomicTerm(table, tenantId, key, request);
  try {
    const result: unknown = await executeTermJson(term);
    return IsWriteResult(result) ? mutationOutcome(result) : "unknown";
  } catch (error) {
    if (isRethinkDBError(error) && DEFINITIVE_ERRORS.has(error.type)) {
      throw error;
    }
    return "unknown";
  }
}

function buildAtomicTerm<T>(
  table: TermJson,
  tenantId: string,
  key: string,
  request: AtomicMutation<T>,
): TermJson {
  const argId = allocateArgNumber();
  const doc: TermJson = [TermType.VAR, [argId]];
  const condition = mutationCondition(doc, tenantId, request);
  const isDelete = request.type !== "update";
  const patch = isDelete
    ? null
    : Object.fromEntries<TermJson>([
        ...Object.entries(request.patch).map(
          ([field, value]): [string, TermJson] => [
            field,
            [TermType.LITERAL, [compiledTerm(value)]],
          ],
        ),
        [request.revisionField, request.nextRevision],
      ]);
  const replacement: TermJson = isDelete
    ? null
    : [TermType.MERGE, [doc, patch]];
  const body: TermJson = [TermType.BRANCH, [condition, replacement, doc]];
  const mutation: TermJson = [
    TermType.FUNC,
    [[TermType.MAKE_ARRAY, [argId]], body],
  ];
  return [
    TermType.REPLACE,
    [[TermType.GET, [table, key]], mutation],
    { durability: "hard", non_atomic: false },
  ];
}

function mutationCondition<T>(
  doc: TermJson,
  tenantId: string,
  request: AtomicMutation<T>,
): TermJson {
  const scope = fieldEquals(doc, TENANT_ID_FIELD, tenantId);
  const expected = expectedCondition(doc, request);
  return [
    TermType.BRANCH,
    [[TermType.EQ, [doc, null]], false, [TermType.AND, [scope, expected]]],
  ];
}

function expectedCondition<T>(
  doc: TermJson,
  request: AtomicMutation<T>,
): TermJson {
  if (request.type === "deleteIfEqual") {
    return fieldEquals(doc, request.field, request.expectedValue);
  }
  if (isRevision(request.expectedRevision)) {
    return fieldEquals(doc, request.revisionField, request.expectedRevision);
  }
  return [
    TermType.NOT,
    [[TermType.CONTAINS, [[TermType.KEYS, [doc]], request.revisionField]]],
  ];
}

function fieldEquals(
  doc: TermJson,
  field: string,
  value: AtomicEqualityValue,
): TermJson {
  return [
    TermType.DEFAULT,
    [
      [TermType.EQ, [[TermType.BRACKET, [doc, field]], compiledTerm(value)]],
      false,
    ],
  ];
}

function mutationOutcome(result: WriteResult): AtomicMutationOutcome {
  if (
    result.errors !== 0 ||
    result.inserted !== 0 ||
    !WRITE_COUNTS.every(
      (field) => Number.isInteger(result[field]) && result[field] >= 0,
    ) ||
    WRITE_COUNTS.reduce((sum, field) => sum + result[field], 0) !== 1
  ) {
    return "unknown";
  }
  return result.replaced + result.deleted === 1 ? "applied" : "not-applied";
}
