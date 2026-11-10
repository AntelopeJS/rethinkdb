# Feature map

One file per feature. `covers:` lists the source globs it owns, `docs:` the pages a verdict judges, and `journeys:` the journeys it runs. `pnpm exec antelopejs-verify map` checks that every user-facing file is covered.

`verify.config.ts` declares one service, a `rethinkdb:2.4` container on a free loopback port. Each journey starts by dropping every database and account of that server, then writes through the module and reads the stored rows back with `rethinkdb-ts`.

[`../coverage.md`](../coverage.md) is the coverage contract: one row per documented behaviour of this module, with the journey and check that fails when it breaks. A verifier checks this layer against it, and a change to the docs adds or edits its rows in the same pull request.

| Feature | What the user does | Journeys |
|---|---|---|
| [smoke](smoke.md) | The fixed journey every verdict runs. | module-dev, insert-values |
| [module](module.md) | Configures `pool`, `connection` or `url` and gets a connected module, or a refusal that says why. | connection-modes, config-refused, external-options |
| [schemas](schemas.md) | Declares a `Schema` and its instances and gets the databases, tables and indexes an owned instance creates. | storage-layout, refused-indexes, refused-registration, instances, cross-instance-indexes |
| [writes](writes.md) | Inserts, updates, replaces and deletes rows on an owned table, with conflict options and counts. | insert-values, insert-conflicts, update-replace-delete |
| [write-values](write-values.md) | Writes values RethinkDB stores specially: bigints, symbols, `undefined`, nested dates and mixed lists. | unstorable-values, stored-values |
| [atomic](atomic.md) | Applies a compare-and-set mutation with `table.atomicMutation`. | atomic-outcomes |
| [reads](reads.md) | Reads with selections, streams, ValueProxy expressions and change feeds on an owned table. | read-selections, read-streams, read-expressions, change-feeds |
| [external-read](external-read.md) | Reads a database the module does not own with `mode: "external"`. | external-reads, external-registration |
| [external-write](external-write.md) | Writes the declared fields of a client's tables and gets the refusals an external instance makes. | external-writes, external-refusals |
| [catalog](catalog.md) | Describes, profiles and samples an external database through `@antelopejs/interface-database-catalog`. | catalog-describe, catalog-refused, catalog-start |
| [raw-client](raw-client.md) | Runs a ReQL query on the module's connection with `RunQuery` from `@antelopejs/interface-rethinkdb`. | raw-client |
