import { TermType } from "rethinkdb-ts/lib/proto/enums";
import { isRethinkDBError } from "rethinkdb-ts/lib/error/error";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import { r, RethinkDBErrorType, type RDatum } from "rethinkdb-ts";
import {
  type AtomicMutation,
  type AtomicMutationOutcome,
  ValidateAtomicMutation,
} from "@antelopejs/interface-database/atomic";

import { executeTermJson } from "../../connection";
import { allocateArgNumber, TENANT_ID_FIELD } from "./utils";

const DEFINITIVE_ERRORS = new Set([
  RethinkDBErrorType.AUTH,
  RethinkDBErrorType.PARSE,
  RethinkDBErrorType.ARITY,
  RethinkDBErrorType.QUERY_LOGIC,
  RethinkDBErrorType.NON_EXISTENCE,
  RethinkDBErrorType.PERMISSION_ERROR,
]);
const WRITE_COUNTS = ["replaced", "deleted", "unchanged", "skipped"];
type CompiledDatum = RDatum<unknown> & { term: TermJson };

export async function runAtomicMutation(
  table: TermJson,
  tenantId: string,
  key: string,
  request: AtomicMutation<Record<string, unknown>>,
): Promise<AtomicMutationOutcome> {
  ValidateAtomicMutation(key, request, [TENANT_ID_FIELD]);
  const term = buildAtomicTerm(table, tenantId, key, request);
  try {
    return mutationOutcome(await executeTermJson(term));
  } catch (error) {
    if (isRethinkDBError(error) && DEFINITIVE_ERRORS.has(error.type)) {
      throw error;
    }
    return "unknown";
  }
}

function buildAtomicTerm(
  table: TermJson,
  tenantId: string,
  key: string,
  request: AtomicMutation<Record<string, unknown>>,
): TermJson {
  const argId = allocateArgNumber();
  const doc: TermJson = [TermType.VAR, [argId]];
  const condition = mutationCondition(doc, tenantId, request);
  const isDelete = request.type !== "update";
  const patch = isDelete
    ? null
    : Object.fromEntries([
        ...Object.entries(request.patch).map(([field, value]) => [
          field,
          [TermType.LITERAL, [(r.expr(value) as CompiledDatum).term]],
        ]),
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

function mutationCondition(
  doc: TermJson,
  tenantId: string,
  request: AtomicMutation<Record<string, unknown>>,
): TermJson {
  const scope = fieldEquals(doc, TENANT_ID_FIELD, tenantId);
  const expected = expectedCondition(doc, request);
  return [
    TermType.BRANCH,
    [[TermType.EQ, [doc, null]], false, [TermType.AND, [scope, expected]]],
  ];
}

function expectedCondition(
  doc: TermJson,
  request: AtomicMutation<Record<string, unknown>>,
): TermJson {
  if (request.type === "deleteIfEqual") {
    return fieldEquals(doc, request.field, request.expectedValue);
  }
  if (typeof request.expectedRevision === "string") {
    return fieldEquals(doc, request.revisionField, request.expectedRevision);
  }
  return [
    TermType.NOT,
    [[TermType.CONTAINS, [[TermType.KEYS, [doc]], request.revisionField]]],
  ];
}

function fieldEquals(doc: TermJson, field: string, value: unknown): TermJson {
  return [
    TermType.DEFAULT,
    [
      [
        TermType.EQ,
        [
          [TermType.BRACKET, [doc, field]],
          (r.expr(value) as CompiledDatum).term,
        ],
      ],
      false,
    ],
  ];
}

function mutationOutcome(result: any): AtomicMutationOutcome {
  if (
    result?.errors !== 0 ||
    result?.inserted !== 0 ||
    !WRITE_COUNTS.every(
      (field) => Number.isInteger(result[field]) && result[field] >= 0,
    ) ||
    WRITE_COUNTS.reduce((sum, field) => sum + result[field], 0) !== 1
  ) {
    return "unknown";
  }
  return result.replaced + result.deleted === 1 ? "applied" : "not-applied";
}
