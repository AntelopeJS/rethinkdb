import { InterfaceFunction } from '@ajs/core/beta';
import { RQuery, RunOptions, r } from 'rethinkdb-ts';

export { r };

/**
 * Executes a RethinkDB query with optional configuration options.
 *
 * @template T - The type of RQuery being executed
 * @param query - The RethinkDB query to execute
 * @param options - Optional configuration for query execution (e.g., read mode, durability)
 * @returns A promise that resolves to the query result type
 * @example
 * ```typescript
 * const result = await RunQuery(r.table('users').get('123'), { readMode: 'outdated' });
 * ```
 */
export const RunQuery: <T extends RQuery>(query: T, options?: RunOptions) => ReturnType<T['run']> = InterfaceFunction<
  (query: RQuery, options?: RunOptions) => any
>() as (...args: any[]) => any;
