import { has, interrupted, type Journey, type JourneyContext } from "@antelopejs/tooling-configs/verify";

import { ERP_SCHEMA, externalConfig, seedClient } from "./external-seed.ts";
import { answered, begin, keysOf, logs, open, owner, pick, refusedRegistration, same, sees, type Answer, type Session } from "./session.ts";

const NO_RETHINKDB = ["@antelopejs/interface-rethinkdb"];
const PREAMBLE = `const ERP = ${ERP_SCHEMA};
const schema = new db.Schema("erp", ERP);
const t = (name) => schema.instance().table(name);
const out = {};
const attempt = async (label, fn) => {
  try { out[label] = await fn(); } catch (error) { out[label] = { error: error.name, kind: error.kind, message: String(error.message) }; }
};
`;

function part(result: Answer, key: string): Answer {
  return { ...result, value: pick(result.value, key) };
}

async function structure(context: JourneyContext, label: string): Promise<{ folder: string; value: string }> {
  const read = await owner(
    context,
    label,
    `const out = { databases: await r.dbList().run(c), tables: {} };
for (const table of await r.db("erp").tableList().run(c)) out.tables[table] = (await r.db("erp").table(table).indexList().run(c)).sort();
return out;`,
  );
  return { folder: read.folder, value: JSON.stringify(read.value) };
}

async function external(context: JourneyContext, account: "erp_reader" | "erp_writer"): Promise<Session> {
  await begin(context);
  await seedClient(context);
  return open(context, externalConfig(context, account), NO_RETHINKDB);
}

async function stopped(session: Session): Promise<void> {
  const result = await session.context.stop("SIGINT", session.app);
  session.context.expect(result.folder, [interrupted(result)]);
}

export const externalReads: Journey = {
  title: "an external instance reads the client's tables verbatim: _id by key type, null for a value the declaration does not read, no undeclared fields, and the structure is never changed",
  entryPoint: "a schema declared as docs/external-mode.md describes, read through `schema.instance().table(...)` with a reader account",
  async run(context) {
    const session = await external(context, "erp_reader");
    const before = await structure(context, "the client's structure before");
    const result = await session.run(
      "read the client database",
      `${PREAMBLE}
await attempt("customers", async () => (await t("customers").orderBy("email")).map((row) => row.email));
await attempt("customerFields", async () => Object.keys((await t("customers").getAll("c1@example.com", "email"))[0]).sort());
await attempt("byIndex", async () => (await t("customers").getAll("c2@example.com", "email")).map((row) => row.name));
await attempt("scan", async () => (await t("customers").filter((row) => row.key("segment").eq("wholesale"))).map((row) => row.name).sort());
await attempt("between", async () => (await t("customers").between("email", "c2@example.com", "c4@example.com")).map((row) => row.name).sort());
await attempt("count", () => t("customers").count());
await attempt("textKey", async () => (await t("products").get("SKU-1")).label);
await attempt("unreadValues", async () => (await t("products").orderBy("sku")).map((row) => [row._id, row.price, row.active]));
await attempt("numberKeys", async () => (await t("numbered").orderBy("no")).map((row) => row._id));
await attempt("numberKeyGet", async () => (await t("numbered").get("7")).label);
await attempt("arrayKeys", async () => (await t("lines").orderBy("qty")).map((row) => row._id));
await attempt("arrayKeyGet", async () => (await t("lines").get('["0c000000-0000-4000-8000-000000000101",2]')).qty);
await attempt("unparsableKey", async () => (await t("lines").get("[bad")) == null ? "absent" : "present");
await attempt("mixedCount", () => t("products_mixed").count());
await attempt("mixedFilter", async () => (await t("products_mixed").filter((row) => row.key("label").eq("number key"))).length);
await attempt("mixedRowKeys", async () => (await t("products_mixed").orderBy("label")).map((row) => Object.keys(row).sort()));
await attempt("mixedGet", () => t("products_mixed").get("T-1"));
return out;`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    context.expect(result.folder, [
      sees("rows come back in the order of the index asked for", part(result, "customers"), ["c1@example.com", "c2@example.com", "c3@example.com", "c4@example.com"]),
      sees("a row answers _id and its declared fields only", part(result, "customerFields"), ["_id", "address", "created_at", "email", "id", "name", "segment", "tags"]),
      sees("getAll by a declared index reads the rows with that value", part(result, "byIndex"), ["Customer 2"]),
      sees("filter compares the declared values", part(result, "scan"), ["Customer 2", "Customer 4"]),
      sees("between by a declared index includes the lower bound and excludes the upper", part(result, "between"), ["Customer 2", "Customer 3"]),
      sees("count counts the table", part(result, "count"), 4),
      sees("a text key is its own _id and addresses itself", part(result, "textKey"), "Widget"),
      sees("a string in a number field reads as null, and so does one in a boolean field", part(result, "unreadValues"), [["SKU-1", 5.5, true], ["SKU-2", null, null]]),
      sees("a number key answers its text", part(result, "numberKeys"), ["7", "8"]),
      sees("a number key is addressed by the number", part(result, "numberKeyGet"), "seven"),
      sees("a compound key answers its JSON text", part(result, "arrayKeys"), ['["0c000000-0000-4000-8000-000000000101",1]', '["0c000000-0000-4000-8000-000000000101",2]']),
      sees("a compound key is addressed by the parsed array", part(result, "arrayKeyGet"), 3),
      sees("a key that does not parse matches nothing", part(result, "unparsableKey"), "absent"),
      sees("a table with keys of two types still counts", part(result, "mixedCount"), 2),
      sees("a table with keys of two types still filters", part(result, "mixedFilter"), 1),
      sees("a table with keys of two types is read without _id", part(result, "mixedRowKeys"), [["label"], ["label"]]),
    ]);
    const mixedGet = pick(result.value, "mixedGet");
    context.expect(result.folder, [has("get by _id on a table with keys of two types is refused", JSON.stringify(mixedGet), /more than one type/)]);
    const after = await structure(context, "the client's structure after");
    context.expect(after.folder, [same("no database, table or index was created or dropped", after.value, before.value)]);
    await stopped(session);
  },
};

export const externalWrites: Journey = {
  title: "an external instance writes the declared fields of the keyed tables its account may write, and leaves undeclared fields, keys and other rows alone",
  entryPoint: "`insert`, `update`, `replace` and `delete` on a schema declared as docs/external-mode.md describes, with a writer account",
  async run(context) {
    const session = await external(context, "erp_writer");
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
return { n1, n2, c1Name: c1.name, c1Address: c1.address, c2, generated: generated.map((row) => /^[0-9a-f-]{36}$/.test(row.id)), deletedGone: deleted === null, noUnknown: (await db.table("customers").get("0c000000-0000-4000-8000-000000000053").run(c)) === null };`,
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

const BASE_TABLES = `notes: { fields: { _id: "string", id: "string", body: "string" }, indexes: {} }`;
const REGISTRATIONS: [string, string, string, RegExp][] = [
  ["a declared table the database does not have", `{ ghost: { fields: { a: "string" }, indexes: {} }, ${BASE_TABLES} }`, "notes", /Table 'bad\.ghost' reads table ghost, which database erp does not have/],
  ["_id declared on a table whose primary keys have two types", `{ products_mixed: { fields: { _id: "string", label: "string" }, indexes: {} } }`, "products_mixed", /Field 'bad\.products_mixed\._id' is declared, but table products_mixed has no usable _id: its primary keys range from NUMBER to STRING, more than one type/],
  ["a field type the module does not know", `{ notes: { fields: { _id: "string", id: "string", body: "mystery" }, indexes: {} } }`, "notes", /Unsupported field type 'mystery' for 'bad\.notes\.body'/],
];

export const externalRegistration: Journey = {
  title: "registration reads the database once and fails with a named reason for a missing table, an _id over multi-type keys or an unknown field type, so no query on that schema answers, and only warns about a partial sample or a missing index",
  entryPoint: "`new Schema(id, definition)` against an external instance and a query on it, read from the query's answer and the run's logs",
  async run(context) {
    for (const [label, definition, table, message] of REGISTRATIONS) {
      const session = await external(context, "erp_writer");
      await refusedRegistration(session, label, `new db.Schema("bad", ${definition})`, `await schema.instance().table("${table}").count();`, message);
      await context.stop("SIGINT", session.app);
    }
    const session = await external(context, "erp_writer");
    const accepted = await session.run(
      "declare what registration accepts with a warning",
      `const schema = new db.Schema("warn", { products: { fields: { _id: "string", sku: "string", label: "string", price: "number" }, indexes: { label: { fields: ["label"] } } } });
await waitFor(2500);
return (await schema.instance().table("products").orderBy("sku")).map((row) => [row._id, row.price]);`,
    );
    context.expect(accepted.folder, [answered(accepted), sees("the schema registers and reads", accepted, [["SKU-1", 5.5], ["SKU-2", null]])]);
    const warnings = await logs(session);
    context.expect(context.work, [
      has("a field some of whose sampled values are not read warns with their share", warnings, /Field 'warn\.products\.price' is declared number, but 1 of 2 sampled values \(50\.0%\) are STRING/),
      has("a declared index the table has no index for warns", warnings, /Index 'label' on 'warn\.products' is declared, but table products has no index over \(label\)/),
    ]);
    await stopped(session);
  },
};
