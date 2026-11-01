import { has, interrupted, type Journey } from "@antelopejs/tooling-configs/verify";

import { answered, begin, open, owner, path, pick, poolConfig, readText, server, same, sees, type Session } from "./session.ts";

const LAYOUT = `
const schema = new db.Schema("verify-layout", {
  users: { fields: { name: "string", email: "string", role: "string" }, indexes: { email: {}, role: { crossInstance: true } } },
  notes: { fields: { title: "string" }, indexes: {} },
});
await schema.createInstance("a");
const ids = await schema.instance("a").table("users").insert({ name: "Ann", email: "ann@example.com", role: "admin" });
return { inserted: ids.length };
`;

async function stopped(session: Session): Promise<void> {
  const result = await session.context.stop("SIGINT", session.app);
  session.context.expect(result.folder, [interrupted(result)]);
}

/** Every schema is a database, every table a table in it, and the indexes are named the way README.md says. */
export const storageLayout: Journey = {
  title: "a schema becomes a database with a table per declared table, a tenant_id index on each, and <name>__i indexes, with an unprefixed index only for crossInstance",
  entryPoint: "`new Schema(id, definition)` and `createInstance()` from a consumer module, read back with rethinkdb-ts",
  async run(context) {
    await begin(context);
    const session = await open(context, poolConfig(server(context)));
    const created = await session.run("declare and create an instance", LAYOUT);
    context.expect(created.folder, [answered(created), sees("one document inserted", created, { inserted: 1 })], { critical: true });
    const native = await owner(
      context,
      "read the layout back",
      `const out = {};
out.databases = (await r.dbList().run(c)).filter((name) => name.startsWith("verify")).sort();
out.tables = (await r.db("verify-layout").tableList().run(c)).filter((name) => name !== "__instances__").sort();
out.userIndexes = (await r.db("verify-layout").table("users").indexList().run(c)).sort();
out.noteIndexes = (await r.db("verify-layout").table("notes").indexList().run(c)).sort();
return out;`,
    );
    context.expect(native.folder, [
      same("the schema is one database", pick(native.value, "databases"), ["verify-layout"]),
      same("each declared table is a table", pick(native.value, "tables"), ["notes", "users"]),
      same("users holds tenant_id, email__i, role__i and the unprefixed role of crossInstance", pick(native.value, "userIndexes"), ["email__i", "role", "role__i", "tenant_id"]),
      same("a table without indexes holds tenant_id only", pick(native.value, "noteIndexes"), ["tenant_id"]),
    ]);
    await stopped(session);
  },
};

export const uniqueRefused: Journey = {
  title: "a schema that declares a unique secondary index is refused at registration, naming the schema, the table and the index, and creates nothing",
  entryPoint: "`new Schema(id, { users: { indexes: { email: { unique: true } } } })` in a consumer module",
  async run(context) {
    await begin(context);
    const session = await open(context, poolConfig(server(context)));
    const refused = await session.run("declare a schema with a unique index", `new db.Schema("verify-unique", { users: { fields: { email: "string" }, indexes: { email: { unique: true } } } });\nawait waitFor(2000);\nreturn "declared";`);
    const stderr = await readText(context, "read the project's errors", path(session.app.folder, "stderr.txt"));
    context.expect(refused.folder, [
      same("the scenario did not complete", refused.ok, false),
      has("the refusal names the index and its table", stderr, /Index 'email' of table 'verify-unique\.users' is declared unique: true/),
    ]);
    const native = await owner(context, "list the databases", `return await r.dbList().run(c);`);
    context.expect(native.folder, [same("no database was created for the refused schema", native.value, ["rethinkdb", "test"])]);
    await context.stop("SIGINT", session.app);
  },
};

export const instances: Journey = {
  title: "rows belong to one instance, the primary key is shared by every instance, CROSS_INSTANCE reads them all and destroyInstance removes only its own",
  entryPoint: "`createInstance`, `listInstances`, `destroyInstance` and `instance(id).table(...)` from a consumer module",
  async run(context) {
    await begin(context);
    const session = await open(context, poolConfig(server(context)));
    const result = await session.run(
      "two instances of one schema",
      `const { CROSS_INSTANCE } = load("@antelopejs/interface-database/schema");
const schema = new db.Schema("verify-instances", { users: { fields: { name: "string", role: "string" }, indexes: { role: { crossInstance: true } } } });
await schema.createInstance("a");
await schema.createInstance("b");
const a = schema.instance("a").table("users");
const b = schema.instance("b").table("users");
await a.insert([{ _id: "shared", name: "Ann", role: "admin" }, { _id: "a2", name: "Al", role: "user" }]);
await b.insert({ _id: "b1", name: "Bo", role: "admin" });
const out = {};
out.instances = (await schema.listInstances()).sort();
out.inA = (await a.count());
out.inB = (await b.count());
out.bSeesAnn = (await b.get("shared")) == null ? "absent" : "present";
try { await b.insert({ _id: "shared", name: "Again" }); out.duplicate = "stored"; } catch (error) {
  out.duplicate = db.IsDuplicateKeyError(error) ? { index: error.index, fields: error.fields } : String(error.message);
}
const admins = await schema.instance(CROSS_INSTANCE).table("users").getAll("admin", "role");
out.crossAdmins = admins.map((row) => row.name).sort();
await schema.destroyInstance("a");
out.afterDestroy = (await schema.listInstances()).sort();
out.inBAfter = await b.count();
return out;`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    context.expect(result.folder, [
      sees("both instances are listed", { ...result, value: pick(result.value, "instances") }, ["a", "b"]),
      sees("instance a holds its two rows", { ...result, value: pick(result.value, "inA") }, 2),
      sees("instance b holds only its own row", { ...result, value: pick(result.value, "inB") }, 1),
      sees("b does not see a's row", { ...result, value: pick(result.value, "bSeesAnn") }, "absent"),
      sees("an _id used by another instance is a DuplicateKeyError on _id", { ...result, value: pick(result.value, "duplicate") }, { index: "_id", fields: ["_id"] }),
      sees("CROSS_INSTANCE reads the admins of every instance", { ...result, value: pick(result.value, "crossAdmins") }, ["Ann", "Bo"]),
      sees("destroyInstance removes a", { ...result, value: pick(result.value, "afterDestroy") }, ["b"]),
      sees("b keeps its row", { ...result, value: pick(result.value, "inBAfter") }, 1),
    ]);
    const native = await owner(context, "count the stored rows", `return await r.db("verify-instances").table("users").count().run(c);`);
    context.expect(native.folder, [same("only b's row is left in the table", native.value, 1)]);
    await stopped(session);
  },
};
