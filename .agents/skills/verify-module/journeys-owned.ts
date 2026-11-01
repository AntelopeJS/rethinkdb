import { interrupted, type Journey } from "@antelopejs/tooling-configs/verify";

import { answered, begin, logs, open, owner, pick, poolConfig, refusedRegistration, server, same, sees, type Json, type Session } from "./session.ts";

const PRESET = `await r.dbCreate("verify-layout").run(c);
await r.db("verify-layout").tableCreate("users", { primaryKey: "_id" }).run(c);
await r.db("verify-layout").table("users").indexCreate("legacy").run(c);
await r.db("verify-layout").table("users").indexWait().run(c);
await r.db("verify-layout").table("users").insert({ _id: "old", name: "Old", email: "old@example.com", role: "user", tenant_id: "a" }).run(c);
return "preset";`;

const LAYOUT = `
const schema = new db.Schema("verify-layout", {
  users: { fields: { name: "string", email: "string", role: "string", tags: ["string"] }, indexes: { email: {}, role: { crossInstance: true }, name_role: { fields: ["name", "role"] }, tags: { multi: true } } },
  notes: { fields: { title: "string" }, indexes: {} },
});
await schema.createInstance("a");
const ids = await schema.instance("a").table("users").insert({ name: "Ann", email: "ann@example.com", role: "admin", tags: ["x"] });
const kept = await schema.instance("a").table("users").get("old");
return { inserted: ids.length, kept: kept ? kept.name : null, count: await schema.instance("a").table("users").count() };
`;

async function stopped(session: Session): Promise<void> {
  const result = await session.context.stop("SIGINT", session.app);
  session.context.expect(result.folder, [interrupted(result)]);
}

/** Every schema is a database, every table a table in it, and the indexes are named the way README.md says. */
export const storageLayout: Journey = {
  title: "a schema becomes a database with a table per declared table, a tenant_id index on each, and <name>__i indexes, with an unprefixed index only for crossInstance; existing tables, rows and indexes are kept",
  entryPoint: "`new Schema(id, definition)` and `createInstance()` from a consumer module over a database that already holds one of its tables, read back with rethinkdb-ts",
  async run(context) {
    await begin(context);
    const preset = await owner(context, "create one of the schema's tables beforehand, with an index of its own and a row", PRESET);
    context.expect(preset.folder, [same("the table, its index and its row exist", preset.value, "preset")], { critical: true });
    const session = await open(context, poolConfig(server(context)));
    const created = await session.run("declare and create an instance", LAYOUT);
    context.expect(created.folder, [answered(created), sees("the instance serves the row its table already held beside the new one", created, { count: 2, inserted: 1, kept: "Old" })], { critical: true });
    const native = await owner(
      context,
      "read the layout back",
      `const out = {};
out.databases = (await r.dbList().run(c)).filter((name) => name.startsWith("verify")).sort();
out.tables = (await r.db("verify-layout").tableList().run(c)).filter((name) => name !== "__instances__").sort();
out.userIndexes = (await r.db("verify-layout").table("users").indexList().run(c)).sort();
out.noteIndexes = (await r.db("verify-layout").table("notes").indexList().run(c)).sort();
out.ready = (await r.db("verify-layout").table("users").indexStatus().run(c)).every((index) => index.ready);
return out;`,
    );
    context.expect(native.folder, [
      same("the schema is one database", pick(native.value, "databases"), ["verify-layout"]),
      same("each declared table is a table", pick(native.value, "tables"), ["notes", "users"]),
      same(
        "users holds tenant_id, a <name>__i index per declared index (simple, compound and multi), the unprefixed role of crossInstance, and its own legacy index, never dropped",
        pick(native.value, "userIndexes"),
        ["email__i", "legacy", "name_role__i", "role", "role__i", "tags__i", "tenant_id"],
      ),
      same("a table without indexes holds tenant_id only", pick(native.value, "noteIndexes"), ["tenant_id"]),
      same("every index is ready once the schema answers", pick(native.value, "ready"), true),
    ]);
    await stopped(session);
  },
};

const REFUSALS: [string, string, RegExp][] = [
  ["a unique secondary index", `{ users: { fields: { email: "string" }, indexes: { email: { unique: true } } } }`, /Index 'email' of table 'verify-refused\.users' is declared unique: true/],
  ["an index name ending in __i", `{ users: { fields: { email: "string" }, indexes: { email__i: {} } } }`, /Index 'email__i' of table 'users' ends with the reserved suffix '__i'/],
];

export const refusedIndexes: Journey = {
  title: "a schema that declares a unique secondary index or an index name ending in __i is refused, naming the index and its table, no query on it answers, and nothing is created",
  entryPoint: "`new Schema(id, { users: { indexes: { email: { unique: true } } } })` or `{ email__i: {} }` in a consumer module, then a query on it",
  async run(context) {
    await begin(context);
    for (const [label, definition, message] of REFUSALS) {
      const session = await open(context, poolConfig(server(context)));
      await refusedRegistration(session, label, `new db.Schema("verify-refused", ${definition})`, `await schema.createInstance("a");\nawait schema.instance("a").table("users").count();`, message);
      await context.stop("SIGINT", session.app);
    }
    const native = await owner(context, "list the databases", `return await r.dbList().run(c);`);
    context.expect(native.folder, [same("no database was created for the refused schemas", native.value, ["rethinkdb", "test"])]);
  },
};

const INSTANCES = `const schema = new db.Schema("verify-instances", {
  users: { fields: { name: "string", role: "string" }, indexes: { role: { crossInstance: true } } },
  notes: { fields: { body: "string" }, indexes: {} },
});`;

export const instances: Journey = {
  title: "rows belong to one instance in every table, the primary key is shared by every instance, CROSS_INSTANCE reads, updates and deletes them all but inserts nothing, listInstances names the named ones, destroyInstance removes only its own in every table, and instances outlive a restart",
  entryPoint: "`createInstance`, `listInstances`, `destroyInstance` and `instance(id | CROSS_INSTANCE).table(...)` from a consumer module, then the same schema after `ajs project dev` restarts",
  async run(context) {
    await begin(context);
    const session = await open(context, poolConfig(server(context)));
    const result = await session.run(
      "three instances of one schema with two tables",
      `const { CROSS_INSTANCE } = load("@antelopejs/interface-database/schema");
${INSTANCES}
const out = {};
out.createdDefault = await schema.createInstance();
out.createdA = await schema.createInstance("a");
await schema.createInstance("b");
const a = schema.instance("a").table("users");
const b = schema.instance("b").table("users");
const home = schema.instance().table("users");
const cross = schema.instance(CROSS_INSTANCE).table("users");
await a.insert([{ _id: "shared", name: "Ann", role: "admin" }, { _id: "a2", name: "Al", role: "user" }]);
await b.insert([{ _id: "b1", name: "Bo", role: "admin" }, { _id: "b2", name: "Bea", role: "user" }]);
await home.insert({ _id: "h1", name: "Hal", role: "admin" });
await schema.instance("a").table("notes").insert([{ _id: "an1", body: "a" }, { _id: "an2", body: "a" }]);
await schema.instance("b").table("notes").insert({ _id: "bn1", body: "b" });
const names = async (table) => (await table).map((row) => row.name).sort();
out.instances = (await schema.listInstances()).sort();
out.inA = await names(a);
out.inB = await names(b);
out.inHome = await names(home);
out.bSeesAnn = (await b.get("shared")) == null ? "absent" : "present";
try { await b.insert({ _id: "shared", name: "Again" }); out.duplicate = "stored"; } catch (error) {
  out.duplicate = db.IsDuplicateKeyError(error) ? { index: error.index, fields: error.fields } : String(error.message);
}
out.crossAdmins = (await cross.getAll("admin", "role")).map((row) => row.name).sort();
out.crossCount = await cross.count();
out.crossUpdateMissing = await cross.get("nobody").update({ role: "x" });
out.crossDeleteMissing = await cross.get("nobody").delete();
try { await cross.insert({ _id: "x1", name: "Nobody", role: "user" }); out.crossInsert = "stored"; } catch (error) { out.crossInsert = "refused"; }
out.crossUpdate = await cross.filter((user) => user.key("role").eq("user")).update({ role: "member" });
out.members = (await cross.getAll("member", "role")).map((row) => row.name).sort();
out.crossDelete = await cross.filter((user) => user.key("role").eq("member")).delete();
out.inAAfterCross = await names(a);
out.inBAfterCross = await names(b);
await schema.destroyInstance("a");
out.afterDestroy = (await schema.listInstances()).sort();
out.inBAfter = await names(b);
out.bNotesAfter = await schema.instance("b").table("notes").count();
out.homeAfter = await names(home);
return out;`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    const part = (key: string) => ({ ...result, value: pick(result.value, key) });
    context.expect(result.folder, [
      sees("createInstance resolves to the instance's id", part("createdA"), "a"),
      sees("listInstances names the named instances, not the default one", part("instances"), ["a", "b"]),
      sees("instance a holds its two rows", part("inA"), ["Al", "Ann"]),
      sees("instance b holds only its own rows", part("inB"), ["Bea", "Bo"]),
      sees("the default instance holds only its own row", part("inHome"), ["Hal"]),
      sees("b does not see a's row", part("bSeesAnn"), "absent"),
      sees("an _id used by another instance is a DuplicateKeyError on _id", part("duplicate"), { index: "_id", fields: ["_id"] }),
      sees("CROSS_INSTANCE reads the admins of every instance", part("crossAdmins"), ["Ann", "Bo", "Hal"]),
      sees("CROSS_INSTANCE counts the rows of every instance", part("crossCount"), 5),
      sees("CROSS_INSTANCE refuses an insert", part("crossInsert"), "refused"),
      sees("a CROSS_INSTANCE update of a missing key resolves to 0, the documents it modified", part("crossUpdateMissing"), 0),
      sees("a CROSS_INSTANCE delete of a missing key resolves to 0, the documents it deleted", part("crossDeleteMissing"), 0),
      sees("a CROSS_INSTANCE update reaches every instance", part("crossUpdate"), 2),
      sees("and stores the change in each", part("members"), ["Al", "Bea"]),
      sees("a CROSS_INSTANCE delete reaches every instance", part("crossDelete"), 2),
      sees("a keeps only its untouched row", part("inAAfterCross"), ["Ann"]),
      sees("b keeps only its untouched row", part("inBAfterCross"), ["Bo"]),
      sees("destroyInstance removes a from the list", part("afterDestroy"), ["b"]),
      sees("b keeps its row", part("inBAfter"), ["Bo"]),
      sees("b keeps its note", part("bNotesAfter"), 1),
      sees("the default instance keeps its row", part("homeAfter"), ["Hal"]),
    ]);
    const native = await owner(
      context,
      "count the stored rows of each instance in each table",
      `const byInstance = async (table) => Object.fromEntries((await r.db("verify-instances").table(table).group("tenant_id").count().run(c)).map((g) => [g.group, g.reduction]));
return { users: await byInstance("users"), notes: await byInstance("notes") };`,
    );
    context.expect(native.folder, [
      same("destroyInstance left no row of a in users, and kept b's and the default instance's", pick(native.value, "users"), { "": 1, b: 1 }),
      same("destroyInstance left no row of a in notes either", pick(native.value, "notes"), { b: 1 }),
    ]);
    await stopped(session);
    const again = await open(context, poolConfig(server(context)));
    const restarted = await again.run(
      "the same schema after a restart",
      `${INSTANCES}
await waitFor(500);
return { instances: (await schema.listInstances()).sort(), b: (await schema.instance("b").table("users")).map((row) => row.name), home: (await schema.instance().table("users")).map((row) => row.name), notes: await schema.instance("b").table("notes").count() };`,
    );
    context.expect(restarted.folder, [answered(restarted), sees("instances and their rows outlive a restart", restarted, { b: ["Bo"], home: ["Hal"], instances: ["b"], notes: 1 })]);
    await stopped(again);
  },
};

const CROSS = `const { CROSS_INSTANCE } = load("@antelopejs/interface-database/schema");
const schema = new db.Schema("verify-cross", {
  items: {
    fields: { name: "string", cat: "string", kind: "string", price: "number", cost: "number", tags: ["string"], labels: ["string"] },
    indexes: {
      cat: {},
      kind: { crossInstance: true },
      cat_price: { fields: ["cat", "price"] },
      kind_cost: { fields: ["kind", "cost"], crossInstance: true },
      tags: { multi: true },
      labels: { multi: true, crossInstance: true },
    },
  },
});
await schema.createInstance("a");
await schema.createInstance("b");
const row = (_id, name, cat, price, tags) => ({ _id, name, cat, kind: cat, price, cost: price, tags, labels: tags });
await schema.instance("a").table("items").insert([row("i1", "A1", "x", 1, ["t1", "t2"]), row("i2", "A2", "y", 2, ["t2"])]);
await schema.instance("b").table("items").insert([row("i3", "B1", "x", 3, ["t1"]), row("i4", "B2", "x", 4, [])]);
const names = (rows) => rows.map((item) => item.name);
const reads = async (items, [simple, compound, multi]) => ({
  getAll: names(await items.getAll("x", simple)).sort(),
  getAllMulti: names(await items.getAll("t1", multi)).sort(),
  between: names(await items.between(simple, "x", "y")).sort(),
  betweenCompound: names(await items.between(compound, ["x", 1], ["x", 4])).sort(),
  orderBy: names(await items.orderBy(compound)),
  orderByDesc: names(await items.orderBy(compound, "desc")),
  distinct: (await items.distinct(simple)).sort(),
  count: await items.count(simple),
});
const out = {};
for (const [scope, id] of [["a", "a"], ["cross", CROSS_INSTANCE]]) {
  const items = schema.instance(id).table("items");
  out[scope] = { plain: await reads(items, ["cat", "cat_price", "tags"]), flagged: await reads(items, ["kind", "kind_cost", "labels"]) };
}
out.again = names(await schema.instance(CROSS_INSTANCE).table("items").getAll("y", "cat"));
return out;`;

const SCOPED_READS = { getAll: ["A1"], getAllMulti: ["A1"], between: ["A1"], betweenCompound: ["A1"], orderBy: ["A1", "A2"], orderByDesc: ["A2", "A1"], distinct: ["x", "y"], count: 2 } satisfies Record<string, Json>;
const CROSS_READS = { getAll: ["A1", "B1", "B2"], getAllMulti: ["A1", "B1"], between: ["A1", "B1", "B2"], betweenCompound: ["A1", "B1"], orderBy: ["A1", "B1", "B2", "A2"], orderByDesc: ["A2", "B2", "B1", "A1"], distinct: ["x", "y"], count: 2 } satisfies Record<string, Json>;

function occurrences(text: string, index: string): number {
  return text.split(`CROSS_INSTANCE query on index '${index}' of table 'verify-cross.items'`).length - 1;
}

export const crossInstanceIndexes: Journey = {
  title: "simple, compound and multi indexes answer the same rows with and without crossInstance, scoped to one instance or across all of them, and a CROSS_INSTANCE read on an index without the flag logs one warning per index",
  entryPoint: "`getAll`, `between`, `orderBy`, `distinct` and `count(field)` on declared indexes of `instance(id)` and `instance(CROSS_INSTANCE)` from a consumer module, and the project's output",
  async run(context) {
    await begin(context);
    const session = await open(context, poolConfig(server(context)));
    const result = await session.run("read through every kind of index, scoped and across instances", CROSS);
    context.expect(result.folder, [answered(result)], { critical: true });
    const scopes: [string, string, Record<string, Json>][] = [["a", "instance a", SCOPED_READS], ["cross", "CROSS_INSTANCE", CROSS_READS]];
    const checks = scopes.flatMap(([scope, label, expected]) =>
      ["plain", "flagged"].flatMap((flag) =>
        Object.entries(expected).map(([read, rows]) => same(`${read} on ${label}, ${flag === "plain" ? "without" : "with"} crossInstance`, pick(result.value, scope, flag, read), rows)),
      ),
    );
    context.expect(result.folder, [...checks, sees("a second CROSS_INSTANCE read still answers", { ...result, value: pick(result.value, "again") }, ["A2"])]);
    const output = await logs(session);
    context.expect(context.work, [
      ...["cat", "cat_price", "tags"].map((index) => same(`a CROSS_INSTANCE read on '${index}', without crossInstance, warns once`, occurrences(output, index), 1)),
      ...["kind", "kind_cost", "labels"].map((index) => same(`a CROSS_INSTANCE read on '${index}', with crossInstance, never warns`, occurrences(output, index), 0)),
    ]);
    await stopped(session);
  },
};
