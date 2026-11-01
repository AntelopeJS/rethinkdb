import { has, interrupted, type Journey, type JourneyContext } from "@antelopejs/tooling-configs/verify";

import { externalConfig, seedClient } from "./external-seed.ts";
import { answered, begin, open, owner, pick, poolConfig, server, same, sees, type Answer } from "./session.ts";

function part(result: Answer, key: string): Answer {
  return { ...result, value: pick(result.value, key) };
}

const LONG = "x".repeat(300);

async function stop(context: JourneyContext, app: Parameters<JourneyContext["stop"]>[1]): Promise<void> {
  const result = await context.stop("SIGINT", app);
  context.expect(result.folder, [interrupted(result)]);
}

export const catalogDescribe: Journey = {
  title: "the catalog of an external instance names the database and account, lists the tables with their keys and write privileges, describes fields and indexes from a sample, profiles a table and samples at most 20 rows cut at 200 characters, writing nothing",
  entryPoint: "`Info`, `ListRelations`, `DescribeRelations`, `Profile` and `SampleRows` of `@antelopejs/interface-database-catalog` from a consumer module",
  async run(context) {
    await begin(context);
    await seedClient(context);
    const longRow = await owner(context, "add a long text to the client database", `await r.db("erp").table("notes").insert({ id: "n3", body: "${LONG}" }).run(c); return "added";`);
    context.expect(longRow.folder, [same("the long row is stored", longRow.exitCode, 0)], { critical: true });
    const before = await owner(context, "read the client rows before", `return await r.db("erp").table("notes").orderBy("id").run(c);`);
    const session = await open(context, externalConfig(context, "erp_writer"), ["@antelopejs/interface-rethinkdb"]);
    const result = await session.run(
      "ask the catalog",
      `const out = {};
const attempt = async (label, fn) => { try { out[label] = await fn(); } catch (error) { out[label] = { error: error.name, message: String(error.message) }; } };
await attempt("info", () => catalog.Info());
await attempt("list", async () => (await catalog.ListRelations()).map((relation) => [relation.name, relation.key && relation.key.columns, relation.writes.insert]));
await attempt("listOther", () => catalog.ListRelations(["elsewhere"]));
await attempt("describe", async () => { const [described] = await catalog.DescribeRelations(["erp.customers"]); return { columns: described.columns.map((column) => [column.name, column.accepts.map((accepted) => accepted.declared)]), indexes: described.indexes.map((index) => [index.name, index.columns, index.unique]) }; });
await attempt("describeMissing", () => catalog.DescribeRelations(["erp.nothing"]));
await attempt("profile", async () => { const profile = await catalog.Profile({ relation: "erp.customers" }); return { rows: profile.rows, columns: profile.columns.map((column) => column.name) }; });
await attempt("sampleTooMany", () => catalog.SampleRows({ relation: "erp.notes", limit: 50 }));
await attempt("sample", async () => { const sample = await catalog.SampleRows({ relation: "erp.notes", limit: 20 }); return { columns: sample.columns, rows: sample.rows.map((row) => row.map((cell) => cell && cell.text ? [cell.text.length, cell.truncated] : cell)) }; });
return out;`,
    );
    context.expect(result.folder, [answered(result)], { critical: true });
    context.expect(result.folder, [
      sees("Info names the engine, the database and the account", part(result, "info"), { database: "erp", engine: "rethinkdb", role: "erp_writer", version: pick(pick(result.value, "info"), "version") ?? null }),
      sees("ListRelations lists each table with its key and whether the account may insert", part(result, "list"), [
        ["customers", ["id"], true],
        ["lines", ["id"], true],
        ["locked", ["id"], false],
        ["notes", ["id"], true],
        ["numbered", ["no"], false],
        ["orders", ["id"], true],
        ["products", ["sku"], false],
        ["products_mixed", null, false],
      ]),
      sees("a schema filter that is not the database lists nothing", part(result, "listOther"), []),
      sees("DescribeRelations reads each field's declaration and the table's indexes", part(result, "describe"), {
        columns: [["id", ["string"]], ["address", ["object"]], ["created_at", ["date"]], ["email", ["string"]], ["name", ["string"]], ["phone", ["string"]], ["segment", ["string"]], ["tags", ["string[]"]]],
        indexes: [["email", ["email"], false]],
      }),
      sees("Profile counts the rows exactly", { ...result, value: pick(pick(result.value, "profile"), "rows") ?? null }, { status: "ok", value: { exact: true, rows: 4 } }),
      sees("SampleRows answers 20 rows at most", { ...result, value: Boolean(pick(pick(result.value, "sampleTooMany"), "error")) }, true),
      sees("SampleRows cuts text at 200 characters and says so", { ...result, value: pick(pick(result.value, "sample"), "rows") ?? null }, [[[2, false], [5, false]], [[2, false], [6, false]], [[2, false], [200, true]]]),
    ]);
    context.expect(result.folder, [
      has("DescribeRelations of an unknown table says which", JSON.stringify(pick(result.value, "describeMissing")), /No relation erp\.nothing that the connected account can list/),
      has("SampleRows over 20 says the bounds", JSON.stringify(pick(result.value, "sampleTooMany")), /A sample answers from 1 to 20 rows, not 50/),
    ]);
    const after = await owner(context, "read the client rows after", `return await r.db("erp").table("notes").orderBy("id").run(c);`);
    context.expect(after.folder, [same("the write probe and the measures changed no row", after.value, before.value)]);
    await stop(context, session.app);
  },
};

export const catalogRefused: Journey = {
  title: "the catalog refuses on an owned instance and on an external one with catalog.enabled false",
  entryPoint: "`Info()` of `@antelopejs/interface-database-catalog` from a consumer module under `ajs project dev`",
  async run(context) {
    await begin(context);
    await seedClient(context);
    const owned = await open(context, poolConfig(server(context)));
    const ownedAnswer = await owned.run("ask an owned instance", `try { return await catalog.Info(); } catch (error) { return { error: error.message }; }`);
    context.expect(ownedAnswer.folder, [has("an owned instance refuses", JSON.stringify(ownedAnswer.value), /this instance owns its tables/)]);
    await stop(context, owned.app);
    const off = await open(context, externalConfig(context, "erp_writer", { catalog: { enabled: false } }), ["@antelopejs/interface-rethinkdb"]);
    const offAnswer = await off.run("ask a disabled catalog", `try { return await catalog.Info(); } catch (error) { return { error: error.message }; }`);
    context.expect(offAnswer.folder, [has("a disabled catalog refuses", JSON.stringify(offAnswer.value), /the catalog is a development tool/)]);
    await stop(context, off.app);
  },
};

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
  },
};
