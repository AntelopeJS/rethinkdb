import { interrupted, type Journey } from "@antelopejs/tooling-configs/verify";

import { answered, begin, open, owner, pick, poolConfig, same, server, sees } from "./session.ts";

const STALE = `await r.dbCreate("verify-stale").run(c);
await r.db("verify-stale").tableCreate("docs", { primaryKey: "_id" }).run(c);
const docs = r.db("verify-stale").table("docs");
await docs.insert({ _id: "a", tenant_id: "i", meta: { code: "X" } }).run(c);
await docs.indexCreate("tenant_id").run(c);
await docs.indexCreate("code__i", (row) => [row("tenant_id"), row("meta.code")]).run(c);
await docs.indexWait().run(c);
return await docs.getAll(["i", "X"], { index: "code__i" }).count().run(c);`;

export const staleIndexRebuild: Journey = {
  title: "booting over a table whose index was built from another function rebuilds it, so reads find the rows by the declared field and no <name>__rebuild index is left",
  entryPoint: "`new Schema(id, definition)` in a consumer module over a database an earlier release created, read back with rethinkdb-ts",
  async run(context) {
    await begin(context);
    const seeded = await owner(context, "build an index from the function an earlier release stored", STALE);
    context.expect(seeded.folder, [same("the stale index finds no row by the nested field", seeded.value, 0)], { critical: true });
    const session = await open(context, poolConfig(server(context)));
    const result = await session.run(
      "boot the schema and read by the declared index",
      `const schema = new db.Schema("verify-stale", { docs: { fields: { meta: { code: "string" } }, indexes: { code: { fields: ["meta.code"] } } } });
await schema.createInstance("i");
const docs = schema.instance("i").table("docs");
return { ids: (await docs.getAll("X", "code")).map((row) => row._id) };`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    context.expect(result.folder, [sees("a read by the declared nested field finds the row the stale index missed", { ...result, value: pick(result.value, "ids") }, ["a"])]);
    const native = await owner(
      context,
      "read the indexes the boot left",
      `const docs = r.db("verify-stale").table("docs");
return { names: (await docs.indexList().run(c)).sort(), found: await docs.getAll(["i", "X"], { index: "code__i" }).count().run(c), rows: await docs.count().run(c) };`,
    );
    context.expect(native.folder, [
      same("the table holds code__i and tenant_id and no code__rebuild", pick(native.value, "names"), ["code__i", "tenant_id"]),
      same("the rebuilt index finds the row by the nested field", pick(native.value, "found"), 1),
      same("the boot kept the row", pick(native.value, "rows"), 1),
    ]);
    const stopped = await context.stop("SIGINT", session.app);
    context.expect(stopped.folder, [interrupted(stopped)]);
  },
};
