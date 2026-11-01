import { interrupted, type Journey } from "@antelopejs/tooling-configs/verify";

import { answered, begin, open, owner, pick, poolConfig, server, same, sees, type Answer, type Json } from "./session.ts";

/** One key of the value a scenario returned, as the answer a `sees` check compares. */
function part(result: Answer, key: string): Answer {
  return { ...result, value: pick(result.value, key) };
}

const DEFINITION = `{ docs: { fields: { title: "string", n: "number", done: "boolean", at: "date", tags: "string[]", meta: "object" }, indexes: {} } }`;

export const insertValues: Journey = {
  title: "insert returns the ids and stores text, numbers, booleans, null, dates, lists and nested documents as those types",
  entryPoint: "`table.insert(document | documents)` from a consumer module, read back with rethinkdb-ts",
  async run(context) {
    await begin(context);
    const session = await open(context, poolConfig(server(context)));
    const result = await session.run(
      "insert documents",
      `const schema = new db.Schema("verify-writes", ${DEFINITION});
await schema.createInstance("a");
const docs = schema.instance("a").table("docs");
const out = {};
await docs.insert({ _id: "one", title: "First", n: 1.5, done: false, at: new Date("2024-03-01T10:00:00.000Z"), tags: ["x", "y"], meta: { deep: { level: 2 } } });
const many = await docs.insert([{ title: "Second" }, { title: "Third", n: null }]);
out.manyCount = many.length;
out.generated = many.every((id) => typeof id === "string" && id.length > 0);
out.readBack = await docs.get("one");
return out;`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    context.expect(result.folder, [
      same("the document is stored under the _id it was given", pick(pick(result.value, "readBack"), "_id"), "one"),
      sees("an array insert resolves to one id per document", part(result, "manyCount"), 2),
      sees("generated ids are non-empty text", part(result, "generated"), true),
      same("the date reads back as the instant that was written", pick(pick(result.value, "readBack"), "at"), "2024-03-01T10:00:00.000Z"),
      same("the nested document reads back whole", pick(pick(result.value, "readBack"), "meta"), { deep: { level: 2 } }),
      same("the list reads back whole", pick(pick(result.value, "readBack"), "tags"), ["x", "y"]),
    ]);
    const types = await owner(
      context,
      "read the stored types",
      `const t = r.db("verify-writes").table("docs");
const one = await t.get("one").do((d) => ({ title: d("title").typeOf(), n: d("n").typeOf(), done: d("done").typeOf(), at: d("at").typeOf(), tags: d("tags").typeOf(), meta: d("meta").typeOf() })).run(c);
const third = await t.filter({ title: "Third" }).nth(0).run(c);
return { one, thirdHasN: Object.hasOwn(third, "n"), thirdN: third.n, count: await t.count().run(c) };`,
    );
    context.expect(types.folder, [
      same("each value is stored as its own ReQL type", pick(types.value, "one"), { at: "PTYPE<TIME>", done: "BOOL", meta: "OBJECT", n: "NUMBER", tags: "ARRAY", title: "STRING" }),
      same("null is stored as null", pick(types.value, "thirdN"), null),
      same("the null field exists", pick(types.value, "thirdHasN"), true),
      same("three documents are stored", pick(types.value, "count"), 3),
    ]);
    const stopped = await context.stop("SIGINT", session.app);
    context.expect(stopped.folder, [interrupted(stopped)]);
  },
};

export const insertConflicts: Journey = {
  title: "inserting a taken _id throws DuplicateKeyError on _id and stores nothing, conflict update keeps unmentioned fields and conflict replace drops them",
  entryPoint: "`table.insert(document, { conflict: \"update\" | \"replace\" })` and the default conflict from a consumer module",
  async run(context) {
    await begin(context);
    const session = await open(context, poolConfig(server(context)));
    const result = await session.run(
      "insert over a taken _id",
      `const schema = new db.Schema("verify-conflicts", ${DEFINITION});
await schema.createInstance("a");
const docs = schema.instance("a").table("docs");
const out = {};
await docs.insert({ _id: "k", title: "First", n: 7, done: true });
try { await docs.insert({ _id: "k", title: "Second" }); out.duplicate = "stored"; } catch (error) {
  out.duplicate = db.IsDuplicateKeyError(error) ? { index: error.index, fields: error.fields } : String(error.message);
}
out.afterDuplicate = await docs.get("k");
out.updateIds = await docs.insert({ _id: "k", title: "Updated" }, { conflict: "update" });
out.afterUpdate = await docs.get("k");
out.replaceIds = await docs.insert({ _id: "k", title: "Replaced" }, { conflict: "replace" });
out.afterReplace = await docs.get("k");
out.count = await docs.count();
return out;`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    const keys = (name: string): Json | undefined => pick(result.value, name);
    context.expect(result.folder, [
      sees("the duplicate is a DuplicateKeyError on _id", part(result, "duplicate"), { index: "_id", fields: ["_id"] }),
      same("the refused insert changed nothing", pick(keys("afterDuplicate"), "title"), "First"),
      sees("conflict update resolves to the id", part(result, "updateIds"), ["k"]),
      same("conflict update changes the mentioned field", pick(keys("afterUpdate"), "title"), "Updated"),
      same("conflict update keeps the fields it does not mention", pick(keys("afterUpdate"), "n"), 7),
      sees("conflict replace resolves to the id", part(result, "replaceIds"), ["k"]),
      same("conflict replace stores the new title", pick(keys("afterReplace"), "title"), "Replaced"),
      same("conflict replace drops the fields it leaves out", pick(keys("afterReplace"), "n"), undefined),
      sees("the upserts never added a second row", part(result, "count"), 1),
    ]);
    const stopped = await context.stop("SIGINT", session.app);
    context.expect(stopped.folder, [interrupted(stopped)]);
  },
};

const USERS = `{ users: { fields: { name: "string", status: "string", loginCount: "number", extra: "string" }, indexes: { status: {} } } }`;

export const updateReplaceDelete: Journey = {
  title: "update changes only the given fields, replace drops the others, delete removes the selection, and each resolves to the number of documents it affected",
  entryPoint: "`get(...).update/replace/delete`, `getAll(...).update` and `filter(...).delete` from a consumer module, read back with rethinkdb-ts",
  async run(context) {
    await begin(context);
    const session = await open(context, poolConfig(server(context)));
    const result = await session.run(
      "update, replace and delete",
      `const schema = new db.Schema("verify-crud", ${USERS});
await schema.createInstance("a");
const users = schema.instance("a").table("users");
await users.insert([
  { _id: "u1", name: "Ann", status: "active", loginCount: 1, extra: "keep" },
  { _id: "u2", name: "Bob", status: "inactive" },
  { _id: "u3", name: "Cy", status: "inactive" },
]);
const out = {};
out.updateOne = await users.get("u1").update({ status: "away" });
out.afterUpdate = await users.get("u1");
out.updateComputed = await users.get("u1").update((user) => ({ loginCount: user.key("loginCount").add(1) }));
out.loginCount = (await users.get("u1")).loginCount;
out.updateMissing = await users.get("nobody").update({ status: "x" });
out.updateMany = await users.getAll("inactive", "status").update({ status: "active" });
out.replaceOne = await users.get("u1").replace({ _id: "u1", name: "Alice" });
out.afterReplace = await users.get("u1");
out.deleteOne = await users.get("u2").delete();
out.deleteFiltered = await users.filter((user) => user.key("name").eq("Cy")).delete();
out.remaining = (await users).map((user) => user._id);
return out;`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    const after = pick(result.value, "afterUpdate");
    const replaced = pick(result.value, "afterReplace");
    context.expect(result.folder, [
      sees("update of one document resolves to 1", part(result, "updateOne"), 1),
      same("update changes the given field", pick(after, "status"), "away"),
      same("update keeps the others", pick(after, "extra"), "keep"),
      sees("update with a function of the row resolves to 1", part(result, "updateComputed"), 1),
      sees("the function added one to the stored number", part(result, "loginCount"), 2),
      sees("update of a missing key resolves to 0", part(result, "updateMissing"), 0),
      sees("update of a getAll selection resolves to its size", part(result, "updateMany"), 2),
      sees("replace resolves to 1", part(result, "replaceOne"), 1),
      same("replace stores the new field", pick(replaced, "name"), "Alice"),
      same("replace removes the fields it leaves out", pick(replaced, "extra"), undefined),
      sees("delete of one document resolves to 1", part(result, "deleteOne"), 1),
      sees("delete of a filtered selection resolves to its size", part(result, "deleteFiltered"), 1),
      sees("only the replaced document is left", part(result, "remaining"), ["u1"]),
    ]);
    const native = await owner(context, "read the replaced document back", `return await r.db("verify-crud").table("users").get("u1").run(c);`);
    context.expect(native.folder, [
      same("rethinkdb-ts reads the new name", pick(native.value, "name"), "Alice"),
      same("the dropped field is gone from the stored document", pick(native.value, "extra"), undefined),
      same("the dropped counter is gone from the stored document", pick(native.value, "loginCount"), undefined),
    ]);
    const stopped = await context.stop("SIGINT", session.app);
    context.expect(stopped.folder, [interrupted(stopped)]);
  },
};
