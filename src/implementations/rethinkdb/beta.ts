import { RQuery, RunOptions } from 'rethinkdb-ts';
import { SendQuery } from '../../connection';
import { TermJson } from 'rethinkdb-ts/lib/internal-types';

type RethinkQueryWithTerm = RQuery & { term: TermJson };

export async function RunQuery(query: RQuery, options?: RunOptions): Promise<unknown> {
  const cursor = await SendQuery((query as RethinkQueryWithTerm).term, options);
  if (!cursor) {
    return;
  }
  const results = await cursor.resolve();
  if (!results) {
    return;
  }
  switch (cursor.getType()) {
    case 'Atom':
      return results[0];
    case 'Cursor':
      return cursor.toArray();
    default:
      return results;
  }
}
