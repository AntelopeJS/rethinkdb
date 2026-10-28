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
- `pnpm run checks` runs every test; there is no separate suite.

<!-- antelopejs-guardrails:start -->
<!-- Managed by @antelopejs/tooling-configs. `antelopejs-sync` rewrites everything between these markers; write repository-specific guidance outside them. -->

## Guardrails

Finish every change with `pnpm run checks`. It runs typecheck, lint, format, knip, tests, size, ratchet, and sync, and prints only what failed. The change is done when it prints no failure.

The tools enforce most rules, listed in the table at the end. The sections below hold the rules no tool checks.

### Comments

Say it in code. A constraint belongs in a type, a lint rule, or a test. A public item's contract belongs in TSDoc (`/** */`) on that item. The only other comments are lint directives that name their rules, `@ts-expect-error <reason>`, `SAFETY: <reason>` above a type assertion, `/*!` license headers, and bundler or formatter directives.

### Tests

Hold every test you write or keep to this checklist:

- Name the wrong implementation this test fails on. A test with no answer is deleted, not kept.
- No test reads the file it tests. Drive the behaviour through the public interface.
- An invariant over many files is a lint rule, not a test.

### Debt

`guardrails.ratchet.json` records the lint findings and oversize files this repository already had. Its numbers only go down. After you remove debt, run `pnpm run ratchet:update` and commit the lowered file. A rule listed there is off for `oxlint`. The ratchet counts it instead, and the pre-commit hook rejects it on every line you add.

### What enforces what

| Rule                                                                           | Enforced by                               |
| ------------------------------------------------------------------------------ | ----------------------------------------- |
| Formatting                                                                     | oxfmt                                     |
| Lint findings are errors; no rule warns                                        | oxlint preset                             |
| Comments are TSDoc, directives, or `SAFETY:` only                              | `antelopejs/no-comments`                  |
| Every test asserts                                                             | `antelopejs/require-assertion`            |
| Tests read no files outside fixtures, helpers, locales                         | `antelopejs/no-fs-read-in-tests`          |
| No assertion that restates a constant                                          | `antelopejs/no-constant-value-assertion`  |
| No test whose only check is "is a function"                                    | `antelopejs/no-typeof-function-only-test` |
| Params ≤ 5, function ≤ 120 lines, file ≤ 500 lines, depth ≤ 4, complexity ≤ 20 | `eslint/max-*`, `eslint/complexity`       |
| Files ≤ 20,000 bytes, tests included                                           | `antelopejs-check-size` (pre-commit)      |
| Existing debt only shrinks                                                     | `antelopejs-ratchet`                      |
| Types check                                                                    | `tsc` (pre-push)                          |
| No dead files, exports, or dependencies                                        | knip                                      |
| Managed files match the pack                                                   | `antelopejs-sync --check`                 |
| A test names the wrong implementation it catches                               | review; no tool                           |

<!-- antelopejs-guardrails:end -->
