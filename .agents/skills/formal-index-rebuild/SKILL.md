---
name: formal-index-rebuild
description: TLA+ model of several boots rebuilding one stale index at once (build `<name>__rebuild`, wait, rename with overwrite, read again, retry up to 5), checked with TLC. Use when a change touches initialize.ts, index-state.ts or indexes.ts, or when a change to how schema initialization creates, drops, renames or waits for an index needs proof that concurrent boots still end with one declared index.
---

# Formal check: concurrent boots rebuilding one stale index

When a table holds an index whose stored function differs from its declaration, every boot of the module that declares it runs `rebuildIndex` (src/implementations/database/initialize.ts). Boots that run together share the index names `N` and `N__rebuild` and send one request at a time to the server: `INDEX_DROP` of a leftover rebuild, `createIndex` (which ignores "already exists"), `INDEX_WAIT`, `INDEX_RENAME` with `overwrite: true`, and after a failed attempt a new `index_status` read. TLC checks every order of those requests, with reads of `N` running throughout, within the bounds below.

## Run it

```sh
pnpm run test:formal
```

It needs `pnpm install` done (the runner comes from `@antelopejs/tooling-configs/formal`) and Java 11 or later from `$JAVA`, else `java` on PATH, else the `eclipse-temurin:21-jre` Docker image (set `TLC_DOCKER_PREFIX` to name the containers). The first run downloads TLC 1.7.4 into `~/.cache/antelopejs-formal` (or `$XDG_CACHE_HOME/antelopejs-formal`) and checks its SHA-256. A run takes about 10 s and explores 353,004 states in the largest configuration. `pnpm test` and so `pnpm run checks` run it, and `antelopejs-verify formal` runs it for a diff that touches the covered code.

- Exit 0 means every rule that held still holds and each finding still breaks with its recorded counterexample length.
- Exit 1 means a rule changed. `BROKEN` names a rule that held and now breaks. `CHANGED` names a finding whose shortest counterexample changed length, or an anchor (below) that no longer matches. `HOLDS` names a finding that no longer breaks.
- Exit 2 means TLC or Java could not run.

## When to run it

Run it when a change touches any file in the coverage record below, or `.agents/skills/formal-index-rebuild/`.

## The rules

| Rule | Plain sentence | On main |
| --- | --- | --- |
| `QueriesFindAnIndex` | Every read of index `N` while boots rebuild it finds an index: the old one until the swap, the new one after. | holds |
| `BootsStoreTheDeclaredFunction` | A boot that ends well leaves the declared function stored under `N`. | holds |
| `NoRebuildLeftBehind` | Once every boot has ended, no `N__rebuild` index is left. | holds |
| `NoBootFailsWhileOthersProgress` | No boot throws its last attempt while another boot is still running. | holds up to 5 boots, breaks from 6 (F1) |

`TypeOK` holds too. Every boot ends in the model: each step has a branch that moves it on, the one wait (`INDEX_WAIT` on a rebuild that is still building) is ended by `BuildFinishes`, and `left` falls on every retry. TLC runs with `-deadlock`, so it does not check this; it follows from the shape of the actions.

## Configurations

`check.mjs` runs each of these, all against `IndexRebuild.tla`.

| Configuration | What it models | Result |
| --- | --- | --- |
| `IndexRebuild` | 4 boots, 5 attempts, a leftover `N__rebuild` built by the old function, 2 reads of `N` | every rule holds |
| `fresh-index` | the same with no leftover rebuild | every rule holds |
| `attempts-bound-holds` | 2 boots, 2 attempts, a leftover | every rule holds |
| `attempts-bound-breaks` | 3 boots, 2 attempts, a leftover | `NoBootFailsWhileOthersProgress` breaks in 12 states (F1, scaled) |
| `swap-by-drop` | a swap that drops `N`, then renames without overwrite | `QueriesFindAnIndex` breaks in 8 states, `BootsStoreTheDeclaredFunction` in 10 |
| `swap-by-copy` | a swap that copies the rebuild over `N` and keeps it | `NoRebuildLeftBehind` breaks in 9 states |
| `keep-leftover` | boots that never drop a leftover rebuild of another function | `BootsStoreTheDeclaredFunction` breaks in 6 states |
| `no-reread` | a failed attempt throws without reading the index again | `NoBootFailsWhileOthersProgress` breaks in 6 states |

The last four change the code on purpose, so each rule is shown to fail on a broken variant of the code it guards. The variants are the constants `SwapByDrop`, `SwapByCopy`, `KeepLeftover` and `NoReread`, all `FALSE` in the code as it is.

## Findings on main

- **F1, a boot can use all its attempts while the others run (`NoBootFailsWhileOthersProgress`), at `Attempts + 1` boots.** Needs a leftover `N__rebuild` built by an older function (an earlier boot that stopped before its swap) and more boots than `REBUILD_ATTEMPTS` (5) reading it together, so 6 or more. Every one of them reads the leftover as stale. The first drops it and builds `N__rebuild`. Each other boot then drops that new rebuild, which fails the first boot's `INDEX_WAIT` or `INDEX_RENAME` ("index not found"), and the first boot reads again and retries. After one such drop by each of the 5 others the first boot has used its 5 attempts and throws `rebuildIndex`'s error while they still run. `retryWithBackoff` in schema.ts then runs the whole initialization again (up to 5 times, 200 ms and doubling), which the model leaves out, so the harm is a logged warning and a delayed boot, not a failed one, unless every retry loses too. The counterexample is the smallest instance of this at 2 attempts and 3 boots (`attempts-bound-breaks`, 12 states): three boots read the leftover, two drop at once so the second's drop fails, and so on until the first boot reads and fails twice. At 5 attempts, TLC finished 5 boots with every rule holding (9,904,551 distinct states, about 3 minutes with 4 workers) and was not run to its end for 6. Replay: 30 boots at once on a 3,000-row table with a leftover rebuild, 10 rounds, against RethinkDB 2.4, threw no error, because the failure needs each drop to land between another boot's create and wait. The code allows each step, but the order was not forced live. Dropping a rebuild that is already gone would make the first drop of each boot harmless. No fix is in this change.

## Real bug or modeling error

Replay the counterexample against the code, one request per step, with the coverage record below. A step order is a modeling error when the code cannot produce it. The likeliest way is two requests of one boot that an `await` joins with no other boot's request between them in practice, though the server may still interleave them. Then fix the model, keep the rule, and say why. Otherwise reproduce it with several `InitializeSchemaDatabase` calls on one table (`src/test/stale-index-rebuild.test.ts` runs 4) and assert what a caller sees.

Read each TLC result with the pstack `/statechart` skill: a violation shows as its shortest path in plain words, and a pass draws how the boots move between states. Work on a copy of the `.tla` file and its configuration in a scratch folder outside the repo.

## Changing the model

- For an intended code change, edit the action that maps to that code, keep the `\* file.ts:NN` comment on each step and update its line, update `ANCHORS` in check.mjs to the same lines, then rerun.
- `ANCHORS` in check.mjs fails the check with `CHANGED anchors` when a line the model describes moved or changed, or when `REBUILD_ATTEMPTS` no longer equals `Attempts` in `IndexRebuild.cfg`. That is the signal to read the covered code again; it is not a failure of the model.
- Never weaken or drop a rule to make the check pass. A fixed finding moves out of `CHECKS` in check.mjs once a replay confirms the fix. A new finding goes into `CHECKS` with its counterexample length, and into this file with its replay.
- After you confirm that the model describes the code at a newer commit, move the sync commit forward. Do it only then.

## Coverage record

| Model action | Code |
| --- | --- |
| `Plan` | `planIndexes`, `readStoredIndexes`, `compareIndex` (src/implementations/database/index-state.ts), `applyIndexPlan`, `ensureIndexes` (initialize.ts:139, 157) |
| `Drop` | `swapInRebuild`, the `INDEX_DROP` of a rebuild whose `rebuildState` is `stale` or `unreadable` (initialize.ts:91) |
| `Create` | `createIndex`, `createIfMissing`, `isAlreadyExists` (initialize.ts:28, 94) |
| `Wait` | the `INDEX_WAIT` of `swapInRebuild` (initialize.ts:95) |
| `Rename` | the `INDEX_RENAME` with `overwrite: true` of `swapInRebuild` (initialize.ts:96) |
| `Reread` | the catch block and loop of `rebuildIndex`, `REBUILD_ATTEMPTS` (initialize.ts:31, 116, 120) |
| `BuildFinishes`, `Query` | the server building an index, and a read through `buildIndexedRead` (indexes.ts) |

The sync commit is `a1b2653` on AntelopeJS/rethinkdb `next`. Every `\* file.ts:NN` comment cites the code at that commit.

## Bounds and what is left out

The default configuration runs 4 boots, 5 attempts, 2 reads and one stale index. A pass covers those bounds; the other configurations cover the shapes above. The model leaves out:

- the `retryWithBackoff` of schema.ts around the whole initialization, and any failure of a request other than a missing index (a dropped connection, a timeout);
- a rebuild stored in a form the comparison cannot read (`unreadable`), and an `N` that is missing (a first boot creates it with `createIndex`, which the rebuild does not touch);
- whether the renamed index is ready, and the `INDEX_WAIT` on every managed index that ends `ensureIndexes`: a read can still meet an index that is building right after a swap;
- several stale indexes of one table, which boot in parallel on different names;
- the `multi` flag: a rebuild is judged by function and flag together, and the model has one "function";
- a boot that starts after another has ended: all boots start together.

`INDEX_RENAME` with `overwrite: true` is modeled as one atomic request: no read sees `N` missing between the old index and the renamed one. That is an assumption about the server, which no test of this repository checks; `swap-by-drop` shows what breaks without it.
