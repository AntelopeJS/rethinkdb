---
covers:
  - src/implementations/database/stream.ts
  - src/implementations/database/expression.ts
  - src/implementations/database/query.ts
docs:
  - README.md
journeys:
  - read-selections
  - read-streams
  - read-expressions
  - change-feeds
---

# Reads

Selections, filters, ordering, slicing, aggregates, groups, joins, lookups, the ValueProxy operations and change feeds on an owned table.

## Sub-features

- `read-selections`: get, getAll, between bounds, filter, pluck, without, orderBy, slice and `for await`.
- `read-streams`: key, by name and by a ValueProxy yielding the name, a document's key with a fallback, default, do, map, union, distinct, count and count(field), sum, avg, min, max, group, join, joinInner, lookup of one key on a stream and a document, nth, orderBy on a compound index, cursor and run.
- `read-expressions`: every operation of docs/1.query_types/9.valueproxy.md on one stored document, dates to the millisecond.
- `change-feeds`: the added, modified and removed events of a table feed and a document feed, scoped to the instance they were opened on.

## How to get to it (user POV)

- `await table.filter(...).orderBy(...).slice(...)`, `for await (const row of table)` and `for await (const change of table.changes())`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" reads
```

## Gotchas

- Each journey starts by dropping every database and account of the run's server (`begin`), because the container has no client to reset it with.
- Every stored row also carries `tenant_id`; the journeys do not assert it.
- Indexed reads across instances, with and without `crossInstance`, are `cross-instance-indexes` in [schemas](schemas.md).
- `nth` past the end of a stream and the `max` argument of `split` are not asserted: the docs give no answer for them.
- A stream's `key(field, fallback)` and `lookup` of a list of keys answer otherwise than the docs (drafted as issues); the journeys assert neither.
