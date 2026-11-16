import { interrupted, type Journey } from "@antelopejs/tooling-configs/verify";

import { text, tuple } from "./json.ts";
import { answered, begin, open, owner, pick, poolConfig, server, same, sees, type Answer, type Json } from "./session.ts";

/** One key of the value a scenario returned, as the answer a `sees` check compares. */
function part(result: Answer, key: string): Answer {
  return { ...result, value: pick(result.value, key) };
}

const DEFINITION = `{ docs: { fields: { title: "string" }, indexes: {} } }`;

export const insertKeys: Journey = {
  title: "insert resolves to the key of every document, provided or generated, in input order, with and without a conflict option",
  entryPoint: "`table.insert(document | documents, options?)` from a consumer module, read back with rethinkdb-ts",
  async run(context) {
    await begin(context);
    const session = await open(context, poolConfig(server(context)));
    const result = await session.run(
      "insert with provided and generated ids",
      `const schema = new db.Schema("verify-keys", ${DEFINITION});
await schema.createInstance("a");
const docs = schema.instance("a").table("docs");
const out = {};
out.provided = await docs.insert({ _id: "p1", title: "Provided" });
out.generated = await docs.insert({ title: "Generated" });
out.mixed = await docs.insert([{ _id: "k1", title: "m1" }, { title: "m2" }, { _id: "k3", title: "m3" }, { title: "m4" }]);
out.conflictUpdate = await docs.insert([{ _id: "k1", title: "m1 updated" }, { title: "m5" }], { conflict: "update" });
out.conflictReplace = await docs.insert([{ title: "m6" }, { _id: "k3", title: "m3 replaced" }], { conflict: "replace" });
return out;`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    const generated = pick(result.value, "generated");
    const mixed = pick(result.value, "mixed");
    const conflictUpdate = pick(result.value, "conflictUpdate");
    const conflictReplace = pick(result.value, "conflictReplace");
    const isKey = (value: Json | undefined): boolean => text(value).length > 0;
    context.expect(result.folder, [
      sees("a document with a provided _id resolves to that _id", part(result, "provided"), ["p1"]),
      same("a document without an _id resolves to one generated key", Array.isArray(generated) ? generated.length : -1, 1),
      same("the generated key is non-empty text", isKey(pick(generated, 0)), true),
      same("an array insert resolves to one key per document", Array.isArray(mixed) ? mixed.length : -1, 4),
      same("a provided _id keeps its place among generated ones, first", pick(mixed, 0), "k1"),
      same("a provided _id keeps its place among generated ones, third", pick(mixed, 2), "k3"),
      same("the generated keys are non-empty text", [isKey(pick(mixed, 1)), isKey(pick(mixed, 3))], [true, true]),
      same("the generated keys differ", pick(mixed, 1) !== pick(mixed, 3), true),
      same("a conflict update resolves to the provided _id, then the generated key", tuple(pick(conflictUpdate, 0), isKey(pick(conflictUpdate, 1))), ["k1", true]),
      same("a conflict replace resolves to the generated key, then the provided _id", tuple(isKey(pick(conflictReplace, 0)), pick(conflictReplace, 1)), [true, "k3"]),
    ]);
    const native = await owner(
      context,
      "read the stored keys by title",
      `const t = r.db("verify-keys").table("docs");
const idOf = async (title) => (await t.filter({ title }).coerceTo("array").run(c)).map((row) => row._id);
return { generated: await idOf("Generated"), m2: await idOf("m2"), m4: await idOf("m4"), m5: await idOf("m5"), m6: await idOf("m6"), k1: (await t.get("k1").run(c)).title, k3: (await t.get("k3").run(c)).title, count: await t.count().run(c) };`,
    );
    context.expect(native.folder, [
      same("the key the insert resolved to is the key stored for a lone generated document", pick(native.value, "generated"), [pick(generated, 0) ?? null]),
      same("the first generated key of the array is the key stored for that document", pick(native.value, "m2"), [pick(mixed, 1) ?? null]),
      same("the second generated key of the array is the key stored for that document", pick(native.value, "m4"), [pick(mixed, 3) ?? null]),
      same("a generated key of a conflict update is the key stored for that document", pick(native.value, "m5"), [pick(conflictUpdate, 1) ?? null]),
      same("a generated key of a conflict replace is the key stored for that document", pick(native.value, "m6"), [pick(conflictReplace, 0) ?? null]),
      same("the conflict update changed the row of its provided _id", pick(native.value, "k1"), "m1 updated"),
      same("the conflict replace changed the row of its provided _id", pick(native.value, "k3"), "m3 replaced"),
      same("eight rows are stored: p1, the lone one, four of the array, one more by update, one more by replace, and no duplicate of k1 or k3", pick(native.value, "count"), 8),
    ]);
    const stopped = await context.stop("SIGINT", session.app);
    context.expect(stopped.folder, [interrupted(stopped)]);
  },
};
