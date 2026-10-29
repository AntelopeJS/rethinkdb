import type { RQuery, RunOptions } from "rethinkdb-ts";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";

import { SendQuery } from "../../connection";

type RethinkQueryWithTerm = RQuery & { term: TermJson };

export async function RunQuery(
  query: RQuery,
  options?: RunOptions,
): ReturnType<RQuery["run"]> {
  // SAFETY: every rethinkdb-ts query carries its compiled `term`, which RQuery leaves undeclared; isQuery cannot check it, since a caller may build the query with its own rethinkdb-ts copy and query symbol.
  const cursor = await SendQuery((query as RethinkQueryWithTerm).term, options);
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
