import { RQuery, RunOptions } from 'rethinkdb-ts';
import { SendQuery } from '../../connection';

// @ts-ignore
export async function RunQuery(query: RQuery, options?: RunOptions): any {
  const cursor = await SendQuery((<any>query).term, options);
  if (!cursor) {
    return;
  }
  const results = await cursor.resolve();
  if (!results) {
    return;
  }
  switch (cursor!.getType()) {
    case 'Atom':
      return results[0];
    case 'Cursor':
      return await cursor.toArray();
    default:
      return results;
  }
}
