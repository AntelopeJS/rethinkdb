# rethinkdb

The RethinkDB backend for AntelopeJS, published as `@antelopejs/rethinkdb`. It implements `@antelopejs/interface-database`, `@antelopejs/interface-database-catalog` and `@antelopejs/interface-rethinkdb` on top of `rethinkdb-ts`.

## Layout

- `src/index.ts` holds the module lifecycle and `src/config.ts` its config, including `mode`: an `owned` instance creates and scopes its tables, an `external` one serves a database it did not create (`docs/external-mode.md`); `src/connection.ts` opens the pool or direct connection, and the per-read connections of an external instance.
- `src/implementations/database/` implements the `query` and `schema` namespaces of `@antelopejs/interface-database`; `src/implementations/rethinkdb/` implements `@antelopejs/interface-rethinkdb`. The `external-*.ts` files are the external mode; `src/implementations/catalog/` implements the catalog interface for an external instance.
- `src/test/antelope.test.ts` is the `ajs module test` project. It loads the module from `.` and runs the compiled suites in `dist/test`. `src/test-external/` holds the external-mode suites and the client database fixture they read.

## Versioning

- `@antelopejs/interface-database` stays capped below the next minor (`>=0.2.0 <0.3.0`), because a new minor can add required handlers.
- When a dependency range changes, update the compatibility table in `README.md` too.
- A release that needs action from users gets an `### Upgrade notes` section in `CHANGELOG.md`, above the generated entries.

## Tests

- Every test needs a RethinkDB 2.4 server on `127.0.0.1:28015`, including `pnpm run checks`. Start it with `docker compose -f .github/release-services.yml up -d --wait`.
- `pnpm test` builds once (`pnpm run build`), then runs `ajs module test .`: the other suites in `src/test/`, compiled to `dist/test`, followed by the shared conformance suites of `@antelopejs/interface-database`. Those suites `require("chai")` from this package, which is why `knip.config.ts` ignores `chai`, `@types/chai` and `@types/mocha`.
- `pnpm test` then runs the external-mode suites in `dist/test-external` with `RETHINK_TEST_MODE=external`: the test project seeds the client database `erp_test` as admin, with `erp_reader` and `erp_writer` accounts, and constructs the module as `erp_writer`. `pnpm test:external` runs only those suites.
- `pnpm test` ends with the formal check of the stale index rebuild, `pnpm run test:formal`: a TLA+ model of concurrent boots, run by TLC from Java on `$JAVA` or `PATH`, else from Docker, described in [`.agents/skills/formal-index-rebuild/SKILL.md`](.agents/skills/formal-index-rebuild/SKILL.md). Run it after a change to `initialize.ts`, `index-state.ts` or `indexes.ts`.
- `pnpm run checks` runs every test; there is no separate suite.

<!-- antelopejs-guardrails:start -->
<!-- Managed by @antelopejs/tooling-configs. `antelopejs-sync` rewrites everything between these markers; write repository-specific guidance outside them. -->

## Guardrails

CI runs `pnpm run checks` in full on every pull request and reports what failed. The commit hook formats and lints the staged files. Locally, run only the fast check for what you touched:

- `pnpm run typecheck` after you change types or signatures.
- `pnpm exec oxlint <files>` and `pnpm exec oxfmt <files>` on the files you changed.
- One test file, not the suite. In a module that tests with `ajs module test`: `pnpm run build`, then `pnpm exec ajs module test . -f dist/<path>.test.js`.

Prove a change works with the verification skill in [`.agents/skills/verify-module/SKILL.md`](.agents/skills/verify-module/SKILL.md) before you call it done.

### Comments

Say it in code: a constraint in a type, a lint rule or a test, a public item's contract in TSDoc. Other comments are lint directives naming their rules, `@ts-expect-error <reason>`, `SAFETY: <reason>` above a type assertion, and license or tool directives. A reason states what the code does now.

### Tests

Each test names the wrong implementation it fails on, or is deleted. Drive behaviour through the public interface. An invariant over many files is a lint rule.

### Review

No tool checks these:

- A type guard checks the nested elements and values it claims.
- A no-upward import rule rejects same-tier peers; probe it with an import.
- A finding only an evasion or a patched internal can trigger goes under Attention and never blocks.

### Suppressions

`guardrails.suppressions.json` caps lint directives, `@ts-expect-error`, `SAFETY:` comments and rules a lint config turns off. Over a cap, fix the code or remove another suppression of that kind; only the operator raises a number. After removing suppressions, run `pnpm run suppressions:update` and commit the file.

<!-- antelopejs-guardrails:end -->
