import { has, interrupted, type Journey, type JourneyContext } from "@antelopejs/tooling-configs/verify";

import { externalConfig, seedClient } from "./external-seed.ts";
import { parseJson } from "./json.ts";
import { answered, begin, freePort, open, owner, path, pick, poolConfig, prepare, server, same, sees, type Answer, type ModuleConfig } from "./session.ts";

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
    const more = await owner(
      context,
      "add four retail customers, three products and three indexes on orders",
      `const db = r.db("erp");
await db.table("customers").insert([5, 6, 7, 8].map((n) => ({ id: "0c000000-0000-4000-8000-00000000020" + n, name: "Customer " + n, email: "x" + n + "@example.com", segment: "retail", created_at: new Date(Date.UTC(2024, 5, 1)), tags: [], address: { city: "Lyon" }, phone: "+33 " + n }))).run(c);
await db.table("products").insert([{ sku: "SKU-3", label: "Gizmo", price: "7", active: false }, { sku: "SKU-4", label: "Doohickey", price: 8, active: true }, { sku: "SKU-5", label: "Thing", price: "9", active: false }]).run(c);
await db.table("orders").indexCreate("cust", (row) => row.getField("customer_id")).run(c);
await db.table("orders").indexCreate("pair", [r.row("customer_id"), r.row("total")]).run(c);
await db.table("orders").indexCreate("double", r.row("total").mul(2)).run(c);
await db.table("orders").indexWait().run(c);
await db.table("lines").insert(Array.from({ length: 130 }, (_, n) => ({ id: ["0c000000-0000-4000-8000-000000000900", n], wide: "w" + (n % 26), narrow: "n" + (n % 25) }))).run(c);
await db.table("locked").insert({ id: "l2", blob: r.binary(Buffer.from("abcd")) }).run(c);
return "added";`,
    );
    context.expect(more.folder, [same("the rows and indexes are stored", more.exitCode, 0)], { critical: true });
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
await attempt("sample21", () => catalog.SampleRows({ relation: "erp.notes", limit: 21 }));
await attempt("sampleColumns", async () => { const sample = await catalog.SampleRows({ relation: "erp.notes", columns: ["body"], limit: 2 }); return { columns: sample.columns, cells: sample.rows.map((row) => row.length), sample: sample.sample }; });
await attempt("describeProducts", async () => { const [described] = await catalog.DescribeRelations(["erp.products"]); return Object.fromEntries(described.columns.map((column) => [column.name, column.accepts.map((accepted) => accepted.declared)])); });
await attempt("describeOrders", async () => { const [described] = await catalog.DescribeRelations(["erp.orders"]); return described.indexes.map((index) => [index.name, index.columns]).sort(); });
await attempt("measures", async () => {
  const profile = await catalog.Profile({ relation: "erp.customers" });
  const column = (name) => profile.columns.find((entry) => entry.name === name) || {};
  const created = column("created_at");
  return {
    emailNulls: column("email").nulls, emailDistinct: column("email").distinct, emailLength: column("email").length, emailRange: column("email").range === undefined, emailCategories: column("email").categories,
    segmentCategories: column("segment").categories, segmentRange: column("segment").range === undefined,
    createdRange: created.range && created.range.status === "ok" ? [new Date(created.range.value.min).toISOString(), new Date(created.range.value.max).toISOString()] : created.range,
    createdMonths: created.months, idTraits: column("id").traits, createdTraits: created.traits, segmentTraits: column("segment").traits,
  };
});
await attempt("spread", async () => { const columns = (await catalog.Profile({ relation: "erp.lines", columns: ["wide", "narrow"] })).columns; const named = (name) => { const found = columns.find((entry) => entry.name === name); return found && found.categories && found.categories.status === "ok" ? found.categories.value.values.length : 0; }; return { wide: named("wide"), narrow: named("narrow") }; });
await attempt("binary", async () => (await catalog.SampleRows({ relation: "erp.locked", columns: ["blob"], limit: 20 })).rows.map((row) => row[0]).filter((cell) => cell !== null));
await attempt("ordersRange", async () => (await catalog.Profile({ relation: "erp.orders" })).columns.find((entry) => entry.name === "total").range);
await attempt("profileColumns", async () => (await catalog.Profile({ relation: "erp.customers", columns: ["email"] })).columns.map((column) => column.name));
await attempt("reference", () => catalog.CheckReference({ from: { relation: "erp.orders", column: "customer_id" }, to: { relation: "erp.customers", column: "id" } }));
await attempt("noReference", () => catalog.CheckReference({ from: { relation: "erp.customers", column: "email" }, to: { relation: "erp.orders", column: "customer_id" } }));
await attempt("unmappable", async () => (await catalog.ListRelations()).filter((relation) => relation.unmappable !== undefined).map((relation) => relation.name));
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
      sees("Profile counts the rows exactly", { ...result, value: pick(pick(result.value, "profile"), "rows") ?? null }, { status: "ok", value: { exact: true, rows: 8 } }),
      sees("SampleRows answers 20 rows at most", { ...result, value: Boolean(pick(pick(result.value, "sampleTooMany"), "error")) }, true),
      sees("SampleRows cuts text at 200 characters and says so", { ...result, value: pick(pick(result.value, "sample"), "rows") ?? null }, [[[2, false], [5, false]], [[2, false], [6, false]], [[2, false], [200, true]]]),
    ]);
    const measure = (key: string): Answer => ({ ...result, value: pick(pick(result.value, "measures"), key) ?? null });
    context.expect(result.folder, [
      has("SampleRows of 21 rows is refused", JSON.stringify(pick(result.value, "sample21")), /A sample answers from 1 to 20 rows, not 21/),
      sees("SampleRows answers only the columns asked for, and says it read a small table whole", part(result, "sampleColumns"), { cells: [1, 1], columns: ["body"], sample: null }),
      sees("a field whose sampled values are at least 80% one type declares it, and one where no type reaches 80% declares nothing", { ...result, value: [pick(pick(result.value, "describeProducts"), "active") ?? null, pick(pick(result.value, "describeProducts"), "price") ?? null] }, [["boolean"], []]),
      sees("an index lists the fields of a getField or of an array of fields, and any other function index lists none", part(result, "describeOrders"), [["cust", ["customer_id"]], ["double", []], ["pair", ["customer_id", "total"]]]),
      sees("Profile counts a column's nulls", measure("emailNulls"), { status: "ok", value: 0 }),
      sees("Profile counts a column's distinct values", measure("emailDistinct"), { status: "ok", value: 8 }),
      sees("Profile measures the lengths of a text column", measure("emailLength"), { status: "ok", value: { avg: 14, max: 14, min: 14 } }),
      sees("text answers no minimum or maximum", measure("emailRange"), true),
      sees("values counted fewer than 5 times are never named, only counted in other", measure("emailCategories"), { status: "ok", value: { other: 8, values: [] } }),
      sees("a value counted at least 5 times is a category, and the rest is counted in other", measure("segmentCategories"), { status: "ok", value: { other: 2, values: [{ rows: 6, value: "retail" }] } }),
      sees("a text column with categories still answers no range", measure("segmentRange"), true),
      sees("a field with 26 distinct values names no category, one with 25 names each, all counted at least 5 times", part(result, "spread"), { narrow: 25, wide: 0 }),
      sees("SampleRows answers a binary value by its length only", part(result, "binary"), [{ bytes: 4 }]),
      sees("Profile answers the ends of a date column as ISO instants", measure("createdRange"), ["2024-02-01T00:00:00.000Z", "2024-06-01T00:00:00.000Z"]),
      sees("Profile counts the rows of a date column per calendar month", measure("createdMonths"), { status: "ok", value: [{ month: "2024-02", rows: 1 }, { month: "2024-03", rows: 1 }, { month: "2024-04", rows: 1 }, { month: "2024-05", rows: 1 }, { month: "2024-06", rows: 4 }] }),
      sees("a column with 5 distinct values over 8 rows is not identifier-like", { ...measure("createdTraits"), value: JSON.stringify(measure("createdTraits").value).includes("identifier-like") }, false),
      sees("a column with 2 distinct values over 8 rows is not identifier-like", { ...measure("segmentTraits"), value: JSON.stringify(measure("segmentTraits").value).includes("identifier-like") }, false),
      has("a column with one distinct value per row, never null, is identifier-like", JSON.stringify(measure("idTraits").value), /"identifier-like"/),
      sees("Profile answers the ends of a number column", part(result, "ordersRange"), { status: "ok", value: { max: 31.5, min: 10.5 } }),
      sees("Profile with columns profiles only those columns", part(result, "profileColumns"), ["email"]),
      sees("CheckReference finds every value of a referring column in the key it names", part(result, "reference"), { status: "ok", value: { checkedRows: 3, containment: 1, sampled: false, targetIsKey: true } }),
      sees("CheckReference of a column whose values the other does not hold finds none, and says the other is not a key", part(result, "noReference"), { status: "ok", value: { checkedRows: 8, containment: 0, sampled: false, targetIsKey: false } }),
      sees("a table whose keys have more than one type is not unmappable: it registers without _id", part(result, "unmappable"), []),
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

const STARTER = `const { spawn } = require("node:child_process");
const [cli, command, appPort, driverPort, body] = process.argv.slice(1);
const child = spawn(process.execPath, [cli, "project", command], { env: { ...process.env, VERIFY_APP_PORT: appPort, VERIFY_DRIVER_PORT: driverPort, PORT: driverPort }, stdio: ["ignore", "inherit", "inherit"] });
let exited = null;
child.on("exit", (code, signal) => { exited = { code, signal }; });
(async () => {
  const deadline = Date.now() + 90000;
  let answer = null;
  while (answer === null && exited === null && Date.now() < deadline) {
    try { answer = await (await fetch("http://127.0.0.1:" + appPort + "/", { method: "POST", body })).json(); } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  if (exited === null) child.kill("SIGINT");
  await new Promise((resolve) => (exited !== null ? resolve() : child.on("exit", resolve)));
  console.log(JSON.stringify({ answer, exited }));
})();`;
const ASK_INFO = `try { return await catalog.Info(); } catch (error) { return { error: error.message }; }`;
const STARTS: [string, "start" | "run", ModuleConfig, RegExp, string][] = [
  ["unset", "start", {}, /the catalog is a development tool/, "under ajs project start, the catalog refuses when catalog.enabled is unset"],
  ["enabled", "start", { catalog: { enabled: true } }, /"engine":"rethinkdb"/, "under ajs project start, the catalog answers when catalog.enabled is true"],
  ["unset", "run", {}, /"engine":"rethinkdb"/, "under ajs project run, the catalog answers when catalog.enabled is unset"],
];

export const catalogStart: Journey = {
  title: "the catalog of an external instance refuses under ajs project start unless catalog.enabled is true, and answers under ajs project run",
  entryPoint: "`Info()` of `@antelopejs/interface-database-catalog` from a consumer module of a project built with `ajs project build` and run with `ajs project start`, and of one run with `ajs project run`",
  async run(context) {
    await begin(context);
    await seedClient(context);
    const cli = path(context.repo, "node_modules/@antelopejs/core/dist/core/cli/index.js");
    for (const [label, command, extra, expected, name] of STARTS) {
      const project = await prepare(context, externalConfig(context, "erp_writer", extra), ["@antelopejs/interface-rethinkdb"]);
      if (command === "start") {
        const built = await context.command(`ajs project build, catalog ${label}`, "node", [cli, "project", "build"], { cwd: project, timeoutMs: 180_000 });
        context.expect(built.folder, [same(`the project builds (catalog ${label})`, built.exitCode, 0)], { critical: true });
      }
      const ports = [await freePort(context), await freePort(context)];
      const started = await context.command(`ajs project ${command}, ask Info, then Ctrl+C (catalog ${label})`, "node", ["-e", STARTER, cli, command, String(ports[0]), String(ports[1]), ASK_INFO], { cwd: project, timeoutMs: 180_000 });
      const outcome = parseJson(started.stdout.trim().split("\n").pop() ?? "");
      const answer = pick(outcome, "answer");
      context.expect(started.folder, [{ name: `the project answered under ajs project ${command} (catalog ${label})`, pass: pick(answer, "ok") === true, detail: JSON.stringify(outcome ?? null).slice(0, 300) }], { critical: true });
      context.expect(started.folder, [has(name, JSON.stringify(pick(answer, "value") ?? null), expected)]);
    }
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
