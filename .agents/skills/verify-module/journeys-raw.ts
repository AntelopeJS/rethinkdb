import { interrupted, type Journey, type JourneyContext } from "@antelopejs/tooling-configs/verify";

import { answered, begin, open, owner, pick, poolConfig, server, same, sees, type Answer } from "./session.ts";

function part(result: Answer, key: string): Answer {
  return { ...result, value: pick(result.value, key) };
}

async function stop(context: JourneyContext, app: Parameters<JourneyContext["stop"]>[1]): Promise<void> {
  const result = await context.stop("SIGINT", app);
  context.expect(result.folder, [interrupted(result)]);
}

export const rawClient: Journey = {
  title: "an owned instance implements interface-rethinkdb: RunQuery runs a ReQL query on the module's connection and exports r",
  entryPoint: "`RunQuery(r.db(...).table(...).insert(...))` of `@antelopejs/interface-rethinkdb` from a consumer module",
  async run(context) {
    await begin(context);
    const session = await open(context, poolConfig(server(context)));
    const result = await session.run(
      "run raw ReQL",
      `const { RunQuery, r } = rdb;
await RunQuery(r.dbCreate("verify-raw"));
await RunQuery(r.db("verify-raw").tableCreate("things"));
const written = await RunQuery(r.db("verify-raw").table("things").insert({ id: "t1", label: "raw" }));
const read = await RunQuery(r.db("verify-raw").table("things").get("t1"));
return { inserted: written.inserted, label: read.label, isSameR: r === rethink.r };`,
    );
    context.expect(result.folder, [answered(result), sees("RunQuery wrote one row", part(result, "inserted"), 1), sees("and reads it back", part(result, "label"), "raw"), sees("r is the rethinkdb-ts one", part(result, "isSameR"), true)]);
    const native = await owner(context, "read the raw row back", `return await r.db("verify-raw").table("things").get("t1").getField("label").run(c);`);
    context.expect(native.folder, [same("rethinkdb-ts reads what RunQuery wrote", native.value, "raw")]);
    await stop(context, session.app);
    const endpoint = server(context);
    const withDb = await open(context, { pool: { host: endpoint.host, port: endpoint.port, user: "admin", password: "", pool: true, cursor: false, silent: true, discovery: false, db: "verify-raw" } });
    const defaulted = await withDb.run("run raw ReQL on the configured default database", `const { RunQuery, r } = rdb;\nreturn (await RunQuery(r.table("things").get("t1"))).label;`);
    context.expect(defaulted.folder, [answered(defaulted), sees("a table named without a database is read from the configured default database", defaulted, "raw")]);
    await stop(context, withDb.app);
  },
};
