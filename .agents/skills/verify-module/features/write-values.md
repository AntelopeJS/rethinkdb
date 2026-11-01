---
covers:
  - src/implementations/database/expression.ts
docs:
  - README.md
journeys:
  - unstorable-values
---

# Write values

How a document handed to `insert`, `update` or `replace` is turned into stored values, as the `WriteValue` page of `@antelopejs/interface-database` documents it: a bigint is refused, a symbol is dropped, `undefined` writes no value, and a date is stored as a time wherever it sits in a list or a nested document.

## Sub-features

- `unstorable-values`: a bigint insert, replace and update reject and store nothing; an undefined field is absent after an insert and keeps the stored field on an update; a symbol field is absent; dates in a list, a nested document and a list inside one read back as `PTYPE<TIME>` with rethinkdb-ts.

## How to get to it (user POV)

- `table.insert(...)`, `get(id).update(...)` and `get(id).replace(...)` with a document that holds one of those values.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" write-values
```

## Gotchas

- The stored types of the plain values (text, numbers, booleans, null, one date, one list) are `insert-values` in [writes](writes.md).
- The journey asserts only that the bigint writes reject, because the docs say RethinkDB refuses it without naming the error.
