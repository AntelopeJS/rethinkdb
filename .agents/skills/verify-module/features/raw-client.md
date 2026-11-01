---
covers:
  - src/implementations/rethinkdb/**
docs:
  - README.md
journeys:
  - raw-client
---

# Raw client

`@antelopejs/interface-rethinkdb` on an owned instance: `RunQuery` runs a ReQL query on the module's connection and exports `r`.

## Sub-features

- `raw-client`: create a database and a table, insert and read through `RunQuery`, read back with `rethinkdb-ts`; with `pool.db` set, a table named without a database is read from it.

## How to get to it (user POV)

- `RunQuery(r.db(...).table(...).get(...))` from a module that imports `@antelopejs/interface-rethinkdb`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" raw-client
```

## Gotchas

- Each journey starts by dropping every database and account of the run's server (`begin`), because the container has no client to reset it with.
- An external instance does not implement this interface; the project lists it in `disabledExports`.
