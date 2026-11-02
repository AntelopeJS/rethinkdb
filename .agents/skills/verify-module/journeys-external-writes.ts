import { has, type Journey } from "@antelopejs/tooling-configs/verify";

import { external, part, PREAMBLE, stopped, structure } from "./external-seed.ts";
import { answered, keysOf, owner, pick, same, sees } from "./session.ts";

export const externalWrites: Journey = {
  title: "an external instance writes the declared fields of the keyed tables its account may write, and leaves undeclared fields, keys and other rows alone",
  entryPoint: "`insert`, `update`, `replace` and `delete` on a schema declared as docs/external-mode.md describes, with a writer account",
  async run(context) {
    const session = await external(context, "erp_writer");
    const prepared = await owner(
      context,
      "let the writer write numbered, and store a note whose body the declaration does not read and one without a body",
      `await r.db("erp").table("numbered").grant("erp_writer", { read: true, write: true }).run(c);
await r.db("erp").table("notes").insert([{ id: "n9", body: 42 }, { id: "n10" }]).run(c);
return "prepared";`,
    );
    context.expect(prepared.folder, [same("the owner prepared the client database", prepared.exitCode, 0)], { critical: true });
    const result = await session.run(
      "write to the client database",
      `${PREAMBLE}
const id = (n) => "0c000000-0000-4000-8000-" + String(n).padStart(12, "0");
await attempt("insertGenerated", async () => (await t("customers").insert({ name: "Generated" })).length);
await attempt("insertKeyed", () => t("customers").insert({ id: id(50), name: "Keyed", email: "k@example.com" }));
await attempt("insertDisagree", () => t("customers").insert({ _id: id(51), id: id(52), name: "Disagree" }));
await attempt("insertNoKeyText", () => t("notes").insert({ body: "x" }));
await attempt("insertUnknown", () => t("customers").insert({ id: id(53), _internal: 1 }));
await attempt("insertObject", () => t("customers").insert({ id: id(54), address: { city: "X" } }));
await attempt("insertDuplicate", () => t("notes").insert({ id: "n1", body: "again" }));
await attempt("updateOwn", () => t("notes").get("n1").update({ body: "changed" }));
await attempt("updateOtherRow", () => t("notes").get("n1").update({ _id: "n2", body: "hijack" }));
await attempt("writeBackWhole", async () => t("notes").get("n2").update(await t("notes").get("n2")));
await attempt("updateScopeFields", () => t("notes").get("n2").update({ body: "scoped", tenant_id: "zzz", _instance: "q" }));
await attempt("updateObjectIgnored", () => t("customers").get(id(1)).update({ address: { city: "Lyon" }, name: "Renamed" }));
await attempt("replace", () => t("customers").get(id(2)).replace({ id: id(2), name: "Replaced" }));
await attempt("deleteOne", () => t("customers").get(id(50)).delete());
await attempt("locked", () => t("locked").insert({ id: "l2", body: "x" }));
await attempt("lockedDelete", () => t("locked").get("l1").delete());
await attempt("upsertReplace", () => t("customers").insert({ id: id(3), name: "Over" }, { conflict: "replace" }));
await attempt("upsertUpdate", () => t("customers").insert({ id: id(4), name: "Upd" }, { conflict: "update" }));
await attempt("numberInsert", () => t("numbered").insert({ no: 9, label: "nine" }));
await attempt("numberUpdate", () => t("numbered").get("7").update({ label: "SEVEN" }));
await attempt("numberDelete", () => t("numbered").get("8").delete());
const line = (n) => JSON.stringify([id(101), n]);
await attempt("arrayInsert", () => t("lines").insert({ _id: line(3), qty: 4 }));
await attempt("arrayUpdate", () => t("lines").get(line(1)).update({ qty: 9 }));
await attempt("arrayDelete", () => t("lines").get(line(2)).delete());
await attempt("nullReadWriteBack", async () => t("notes").get("n9").update(await t("notes").get("n9")));
await attempt("absentReadWriteBack", async () => t("notes").get("n10").update(await t("notes").get("n10")));
return out;`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    const refusal = (key: string, pattern: RegExp, kind: string) =>
      has(`${key} is refused as ${kind}`, JSON.stringify(pick(result.value, key)), pattern);
    context.expect(result.folder, [
      sees("an insert without a key lets the server generate a uuid", part(result, "insertGenerated"), 1),
      refusal("insertDisagree", /"kind":"invalid"/, "invalid"),
      refusal("insertNoKeyText", /"kind":"invalid".*keys of type string are not generated/, "invalid"),
      refusal("insertUnknown", /"kind":"invalid".*Field '_internal' of customers is not a declared field/, "invalid"),
      refusal("insertObject", /"kind":"invalid".*Field 'address' of customers is read-only/, "invalid"),
      refusal("insertDuplicate", /"error":"DuplicateKeyError"/, "a DuplicateKeyError"),
      sees("update changes one row", part(result, "updateOwn"), 1),
      sees("an update whose _id names another row writes nothing", part(result, "updateOtherRow"), 0),
      sees("a row read and written back whole changes nothing", part(result, "writeBackWhole"), 0),
      sees("_instance and tenant_id are dropped, the declared field is written", part(result, "updateScopeFields"), 1),
      sees("an object field in an update is ignored, the declared field is written", part(result, "updateObjectIgnored"), 1),
      sees("replace answers 1", part(result, "replace"), 1),
      sees("delete answers 1", part(result, "deleteOne"), 1),
      refusal("locked", /"kind":"forbidden"/, "forbidden"),
      refusal("lockedDelete", /"kind":"forbidden"/, "forbidden"),
      sees("an insert with a key answers that key", part(result, "insertKeyed"), ["0c000000-0000-4000-8000-000000000050"]),
      sees("a conflict replace answers the key", part(result, "upsertReplace"), ["0c000000-0000-4000-8000-000000000003"]),
      sees("a conflict update answers the key", part(result, "upsertUpdate"), ["0c000000-0000-4000-8000-000000000004"]),
      sees("an insert on a number-key table answers the key's text", part(result, "numberInsert"), ["9"]),
      sees("an update on a number-key table changes one row", part(result, "numberUpdate"), 1),
      sees("a delete on a number-key table removes one row", part(result, "numberDelete"), 1),
      sees("an insert on a compound-key table answers the key's JSON text", part(result, "arrayInsert"), ['["0c000000-0000-4000-8000-000000000101",3]']),
      sees("an update on a compound-key table changes one row", part(result, "arrayUpdate"), 1),
      sees("a delete on a compound-key table removes one row", part(result, "arrayDelete"), 1),
      sees("a row whose field read as null, written back whole, changes nothing", part(result, "nullReadWriteBack"), 0),
      sees("a row missing a declared field, written back whole, changes nothing", part(result, "absentReadWriteBack"), 0),
    ]);
    const duplicate = JSON.stringify(pick(result.value, "insertDuplicate"));
    context.expect(result.folder, [has("a DuplicateKeyError quotes no row", duplicate, /^((?!again).)*$/)]);
    const native = await owner(
      context,
      "read the client's rows back",
      `const db = r.db("erp");
const n1 = await db.table("notes").get("n1").run(c);
const n2 = await db.table("notes").get("n2").run(c);
const c1 = await db.table("customers").get("0c000000-0000-4000-8000-000000000001").run(c);
const c2 = await db.table("customers").get("0c000000-0000-4000-8000-000000000002").run(c);
const generated = await db.table("customers").filter({ name: "Generated" }).run(c);
const deleted = await db.table("customers").get("0c000000-0000-4000-8000-000000000050").run(c);
return { n1, n2, c1Name: c1.name, c1Address: c1.address, c2, generated: generated.map((row) => /^[0-9a-f-]{36}$/.test(row.id)), deletedGone: deleted === null, noUnknown: (await db.table("customers").get("0c000000-0000-4000-8000-000000000053").run(c)) === null, c3: await db.table("customers").get("0c000000-0000-4000-8000-000000000003").run(c), c4: await db.table("customers").get("0c000000-0000-4000-8000-000000000004").pluck("name", "email", "segment", "phone").run(c), numbered: await db.table("numbered").orderBy("no").run(c), lines: (await db.table("lines").orderBy("id").run(c)).map((row) => [row.id[1], row.qty]), n9: await db.table("notes").get("n9").run(c), n10: await db.table("notes").get("n10").run(c) };`,
    );
    context.expect(native.folder, [
      same("update wrote the declared field and kept the row", pick(pick(native.value, "n1"), "body"), "changed"),
      same("the row named by the refused _id was not touched", pick(pick(native.value, "n2"), "body"), "scoped"),
      same("tenant_id and _instance were never stored", keysOf(pick(native.value, "n2")), ["body", "id"]),
      same("an object field in an update keeps its stored value", pick(native.value, "c1Address"), { city: "Paris" }),
      same("update renamed the customer", pick(native.value, "c1Name"), "Renamed"),
      same("replace removed the declared fields it left out (segment, email, created_at) and kept the undeclared phone and the read-only object and list fields", pick(native.value, "c2"), { address: { city: "Paris" }, id: "0c000000-0000-4000-8000-000000000002", name: "Replaced", phone: "+33 2", tags: [] }),
      same("the generated key is a uuid", pick(native.value, "generated"), [true]),
      same("delete removed the row", pick(native.value, "deletedGone"), true),
      same("a refused insert stored nothing", pick(native.value, "noUnknown"), true),
      same("a conflict replace removed the declared fields it left out and kept the undeclared phone and the read-only fields", pick(native.value, "c3"), { address: { city: "Paris" }, id: "0c000000-0000-4000-8000-000000000003", name: "Over", phone: "+33 3", tags: [] }),
      same("a conflict update wrote the name and kept the fields it did not send", pick(native.value, "c4"), { email: "c4@example.com", name: "Upd", phone: "+33 4", segment: "wholesale" }),
      same("the number-key table holds the updated and the inserted rows, keyed by numbers", pick(native.value, "numbered"), [{ label: "SEVEN", no: 7 }, { label: "nine", no: 9 }]),
      same("the compound-key table holds the updated and the inserted rows, keyed by arrays", pick(native.value, "lines"), [[1, 9], [3, 4]]),
      same("a field read as null kept its stored value", pick(native.value, "n9"), { body: 42, id: "n9" }),
      same("a field read as absent kept its absence", pick(native.value, "n10"), { id: "n10" }),
    ]);
    await stopped(session);
  },
};

export const externalRefusals: Journey = {
  title: "an external instance refuses what docs/external-mode.md excludes: writes to multi-type keys, mapper updates, change feeds, atomic mutations and instances",
  entryPoint: "the refused calls on a schema declared as docs/external-mode.md describes, with a writer account",
  async run(context) {
    const session = await external(context, "erp_writer");
    const before = await structure(context, "the client's structure before");
    const result = await session.run(
      "call what is excluded",
      `${PREAMBLE}
await attempt("mixedInsert", () => t("products_mixed").insert({ sku: "X", label: "x" }));
await attempt("mixedUpdate", () => t("products_mixed").filter((row) => row.key("label").eq("text key")).update({ label: "y" }));
await attempt("mixedDelete", () => t("products_mixed").filter((row) => row.key("label").eq("text key")).delete());
await attempt("mixedGetAll", () => t("products_mixed").getAll("T-1"));
await attempt("mapper", () => t("notes").get("n1").update((row) => ({ body: row.key("body") })));
await attempt("changes", async () => { for await (const change of t("notes").changes()) return change; });
await attempt("atomic", () => t("notes").atomicMutation("n1", { type: "deleteIfEqual", field: "body", expectedValue: "first" }));
await attempt("create", () => schema.createInstance("extra"));
await attempt("destroy", () => schema.destroyInstance("extra"));
out.listed = await schema.listInstances();
return out;`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    const says = (key: string, pattern: RegExp) => has(`${key} is refused with its reason`, JSON.stringify(pick(result.value, key)), pattern);
    context.expect(result.folder, [
      says("mixedInsert", /more than one type.*cannot be written/),
      says("mixedUpdate", /"error":"/),
      says("mixedDelete", /"error":"/),
      says("mixedGetAll", /more than one type/),
      says("mapper", /computed from the row is not supported on an external table/),
      says("changes", /changes\(\) is not supported on table notes/),
      says("atomic", /'atomicMutation' stage is not supported on table notes/),
      says("create", /'createInstance' stage manages instances/),
      says("destroy", /'destroyInstance' stage manages instances/),
      sees("listInstances is empty", part(result, "listed"), []),
    ]);
    const after = await structure(context, "the client's structure after");
    context.expect(after.folder, [same("the refused calls changed nothing", after.value, before.value)]);
    const native = await owner(context, "read the multi-type table back", `return await r.db("erp").table("products_mixed").orderBy("label").getField("label").run(c);`);
    context.expect(native.folder, [same("no row of the multi-type table was written", native.value, ["number key", "text key"])]);
    await stopped(session);
  },
};
