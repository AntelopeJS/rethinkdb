---
covers:
  - src/probe.ts
docs:
  - docs/external-mode.md
journeys:
  - connection-probe
---

# Connection probe

`probe` of `@antelopejs/interface-database-catalog`, required from `@antelopejs/rethinkdb/dist/probe` outside the AntelopeJS runtime: it signs in with a URL, times a first query and answers what the account may do in the database the URL names, with no row or table changed.

## Sub-features

- `connection-probe`: admin, an account that may only read and an account with the `config` right on a database with no table and on one with tables (the right to create tables counts as write access, so an empty database it may build in is not read-only), a database the server lacks, a URL with no database and a wrong password; the probes leave the databases as they were.

## How to get to it (user POV)

- `const { probe } = require("@antelopejs/rethinkdb/dist/probe"); await probe({ url, timeoutMs, signal })`.

## Driving it with antelopejs-verify

```bash
pnpm exec antelopejs-verify journey "$RUN" probe
```

## Gotchas

- The journey needs the built `dist/probe.js`; `new` builds it.
- The bounds of the probe (32 tables at a time, `timeoutMs`, `signal`, a server that asks for more than 100,000 iterations, a dropped connection) need a server that stalls or lies; `src/test/probe.test.js` and `src/test/probe-credentials.test.js` drive them through a relay, and no journey does.
