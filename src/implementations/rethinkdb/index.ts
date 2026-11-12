import assert from "node:assert";
import type { RQuery, RunOptions } from "rethinkdb-ts";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";

import { SendQuery } from "../../connection";
import { IsTermJson } from "../database/utils";

/** The compiled term every rethinkdb-ts query carries, whichever copy of rethinkdb-ts built it. */
function TermOf(query: RQuery): TermJson {
  assert(
    "term" in query && IsTermJson(query.term),
    "Expected a rethinkdb-ts query carrying its compiled term",
  );
  return query.term;
}

export async function RunQuery(
  query: RQuery,
  options?: RunOptions,
): ReturnType<RQuery["run"]> {
  const cursor = await SendQuery(TermOf(query), options);
  if (!cursor) {
    return;
  }
  const results = await cursor.resolve();
  if (!results) {
    return;
  }
  switch (cursor.getType()) {
    case "Atom":
      return results[0];
    case "Cursor":
      return cursor.toArray();
    default:
      return results;
  }
}
