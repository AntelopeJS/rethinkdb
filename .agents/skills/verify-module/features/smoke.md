---
covers:
docs:
  - README.md
journeys:
  - module-dev
  - insert-values
---

# Smoke

The fixed journey every verdict runs, whatever the diff touches: load the module as `local` against the run's RethinkDB container, write documents through a consumer module and read their stored types back with `rethinkdb-ts`.

## Sub-features

- `module-dev`: the pack's journey, registered again in `verify.config.ts` under the same id so it is guarded like every repository journey: a RethinkDB that stops answering after `ajs project dev` starts ends it NOT VERIFIED, not FAIL. The copy keeps the pack's steps and checks.
- `insert-values`: as in [writes](writes.md).

## How to get to it (user POV)

- A project with `@antelopejs/rethinkdb` and a module that imports `@antelopejs/interface-database`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" smoke
```

## Gotchas

- Each journey starts by dropping every database and account of the run's server (`begin`), because the container has no client to reset it with.
- The smoke feature covers no glob, so it never marks a file as mapped.
