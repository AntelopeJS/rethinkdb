---
covers:
  - src/implementations/database/selection.ts
  - src/implementations/database/selection-stages.ts
  - src/write-result.ts
docs:
  - README.md
journeys:
  - insert-values
  - insert-conflicts
  - update-replace-delete
---

# Writes

`insert`, `update`, `replace` and `delete` on an owned table, with the write stages the interface records: the stored types of the documented values, the conflict options, the duplicate-key error and the counts each write resolves to.

## Sub-features

- `insert-values`: text, numbers, booleans, null, dates, lists and nested documents are stored as those ReQL types.
- `insert-conflicts`: a taken `_id` throws `DuplicateKeyError` on `_id` and stores nothing; `conflict: "update"` keeps unmentioned fields and `"replace"` drops them.
- `update-replace-delete`: counts and effects of the four writes, with a function update and getAll and filter selections; an update that changes nothing resolves to 0, since update counts the documents it modified.

## How to get to it (user POV)

- `table.insert(...)`, `get(id).update(...)`, `getAll(...).update(...)`, `replace`, `delete`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" writes
```

## Gotchas

- Each journey starts by dropping every database and account of the run's server (`begin`), because the container has no client to reset it with.
- Values RethinkDB cannot store (a bigint, `undefined`, a symbol) and dates inside lists and nested documents are [write-values](write-values.md).
- A plain `insert` of a document with a provided `_id` resolves to no id (drafted as an issue); the journeys assert the stored row instead.
