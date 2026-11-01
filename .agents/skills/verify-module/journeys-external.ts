import { has, type Journey } from "@antelopejs/tooling-configs/verify";

import { external, part, PREAMBLE, stopped, structure } from "./external-seed.ts";
import { answered, logs, pick, refusedRegistration, same, sees } from "./session.ts";

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
const uuid = (n) => "0c000000-0000-4000-8000-" + String(n).padStart(12, "0");
await attempt("getAllList", async () => (await t("customers").getAll([uuid(1), uuid(3)])).map((row) => row.name).sort());
await attempt("numberGetAllList", async () => (await t("numbered").getAll(["7", "8"])).map((row) => row.label).sort());
await attempt("betweenId", async () => (await t("customers").between("_id", uuid(2), uuid(4))).map((row) => row.name).sort());
await attempt("orderDesc", async () => (await t("customers").orderBy("email", "desc")).map((row) => row.email));
await attempt("named", () => schema.instance("tenant").table("notes").count());
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
    context.expect(result.folder, [
      has("get by _id on a table with keys of two types is refused", JSON.stringify(mixedGet), /more than one type/),
      sees("getAll with a list of keys reads each row", part(result, "getAllList"), ["Customer 1", "Customer 3"]),
      sees("getAll with a list of number keys reads each row", part(result, "numberGetAllList"), ["eight", "seven"]),
      sees("between by _id includes the lower bound and excludes the upper", part(result, "betweenId"), ["Customer 2", "Customer 3"]),
      sees("orderBy a declared index descending reverses the order", part(result, "orderDesc"), ["c4@example.com", "c3@example.com", "c2@example.com", "c1@example.com"]),
      has("a named instance of an external table is refused", JSON.stringify(pick(result.value, "named")), /"error":"/),
    ]);
    const after = await structure(context, "the client's structure after");
    context.expect(after.folder, [same("no database, table or index was created or dropped", after.value, before.value)]);
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
    const codec = await session.run(
      "declare a field with an io-ts codec",
      `const Body = { name: "Body", is: (value) => typeof value === "string", encode: (value) => value, decode: (value) => ({ _tag: "Right", right: value }) };
const schema = new db.Schema("codec", { notes: { fields: { _id: "string", id: "string", body: Body }, indexes: {} } });
await waitFor(2000);
return await schema.instance().table("notes").count();`,
    );
    context.expect(codec.folder, [answered(codec), sees("a field declared with an io-ts codec is a known type: the schema, labelled codec, registers and reads the url's notes", codec, 2)]);
    const warnings = await logs(session);
    context.expect(context.work, [
      has("a field some of whose sampled values are not read warns with their share", warnings, /Field 'warn\.products\.price' is declared number, but 1 of 2 sampled values \(50\.0%\) are STRING/),
      has("a declared index the table has no index for warns", warnings, /Index 'label' on 'warn\.products' is declared, but table products has no index over \(label\)/),
    ]);
    await stopped(session);
  },
};

