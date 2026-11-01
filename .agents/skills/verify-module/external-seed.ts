import { interrupted, type JourneyContext } from "@antelopejs/tooling-configs/verify";

import { begin, open, owner, pick, server, type Answer, type ModuleConfig, type Session } from "./session.ts";

export const CLIENT = "erp";
export const PASSWORD = "erp-password";

/** What the database's owner creates before the module constructs: the client database, its rows and a reader and a writer account. */
const SEED = `const db = r.db("erp");
await r.dbCreate("erp").run(c);
for (const table of ["customers", "orders", "notes", "locked"]) await db.tableCreate(table).run(c);
await db.tableCreate("products", { primaryKey: "sku" }).run(c);
await db.tableCreate("products_mixed", { primaryKey: "sku" }).run(c);
await db.tableCreate("numbered", { primaryKey: "no" }).run(c);
await db.tableCreate("lines").run(c);
const uuid = (n) => "0c000000-0000-4000-8000-" + String(n).padStart(12, "0");
await db.table("customers").insert([1, 2, 3, 4].map((n) => ({ id: uuid(n), name: "Customer " + n, email: "c" + n + "@example.com", segment: n % 2 ? "retail" : "wholesale", created_at: new Date(Date.UTC(2024, n, 1)), tags: n === 1 ? ["vip"] : [], address: { city: "Paris" }, phone: "+33 " + n }))).run(c);
await db.table("customers").indexCreate("email").run(c);
await db.table("customers").indexWait().run(c);
await db.table("orders").insert([1, 2, 3].map((n) => ({ id: uuid(100 + n), customer_id: uuid(n), total: n * 10.5 }))).run(c);
await db.table("notes").insert([{ id: "n1", body: "first" }, { id: "n2", body: "second" }]).run(c);
await db.table("locked").insert([{ id: "l1", body: "locked" }]).run(c);
await db.table("products").insert([{ sku: "SKU-1", label: "Widget", price: 5.5, active: true }, { sku: "SKU-2", label: "Gadget", price: "12", active: "yes" }]).run(c);
await db.table("products_mixed").insert([{ sku: "T-1", label: "text key" }, { sku: 42, label: "number key" }]).run(c);
await db.table("numbered").insert([{ no: 7, label: "seven" }, { no: 8, label: "eight" }]).run(c);
await db.table("lines").insert([{ id: [uuid(101), 1], qty: 2 }, { id: [uuid(101), 2], qty: 3 }]).run(c);
const users = r.db("rethinkdb").table("users");
for (const user of ["erp_reader", "erp_writer"]) {
  await users.insert({ id: user, password: "${PASSWORD}" }).run(c);
  await db.grant(user, { read: true }).run(c);
}
for (const table of ["customers", "orders", "notes", "lines"]) await db.table(table).grant("erp_writer", { read: true, write: true }).run(c);
return "seeded";`;

/** Creates the client database as its owner would. */
export async function seedClient(context: JourneyContext): Promise<void> {
  const seeded = await owner(context, "seed the client database", SEED);
  context.expect(seeded.folder, [{ name: "the client database is seeded", pass: seeded.exitCode === 0, detail: seeded.stderr }], { critical: true });
}

/** The external module config for an account of the client database. */
export function externalConfig(context: JourneyContext, account: "erp_reader" | "erp_writer", extra: ModuleConfig = {}): ModuleConfig {
  const endpoint = server(context);
  return { mode: "external", url: `rethinkdb://${account}:${PASSWORD}@${endpoint.host}:${endpoint.port}/${CLIENT}`, pool: { pool: true, cursor: false, silent: true, discovery: false }, ...extra };
}

export const ERP_SCHEMA = `{
  customers: { fields: { _id: "string", id: "string", name: "string", email: "string", segment: "string", created_at: "date", tags: "string[]", address: "object" }, indexes: { email: { fields: ["email"] } } },
  orders: { fields: { _id: "string", id: "string", customer_id: "string", total: "number" }, indexes: {} },
  notes: { fields: { _id: "string", id: "string", body: "string" }, indexes: {} },
  locked: { fields: { _id: "string", id: "string", body: "string" }, indexes: {} },
  products: { fields: { _id: "string", sku: "string", label: "string", price: "number", active: "boolean" }, indexes: {} },
  products_mixed: { fields: { label: "string" }, indexes: {} },
  numbered: { fields: { _id: "string", no: "number", label: "string" }, indexes: {} },
  lines: { fields: { _id: "string", qty: "number" }, indexes: {} },
}`;

/** The interface an external instance does not implement, which the project lists in `disabledExports`. */
export const NO_RETHINKDB = ["@antelopejs/interface-rethinkdb"];
/** The start of a scenario body on the client database: the schema `erp`, `t(name)` for its tables and `attempt` recording each answer or error in `out`. */
export const PREAMBLE = `const ERP = ${ERP_SCHEMA};
const schema = new db.Schema("erp", ERP);
const t = (name) => schema.instance().table(name);
const out = {};
const attempt = async (label, fn) => {
  try { out[label] = await fn(); } catch (error) { out[label] = { error: error.name, kind: error.kind, message: String(error.message) }; }
};
`;

/** The answer narrowed to one key of its value. */
export function part(result: Answer, key: string): Answer {
  return { ...result, value: pick(result.value, key) };
}

/** The client's databases, tables and indexes, read as its owner. */
export async function structure(context: JourneyContext, label: string): Promise<{ folder: string; value: string }> {
  const read = await owner(
    context,
    label,
    `const out = { databases: await r.dbList().run(c), tables: {} };
for (const table of await r.db("erp").tableList().run(c)) out.tables[table] = (await r.db("erp").table(table).indexList().run(c)).sort();
return out;`,
  );
  return { folder: read.folder, value: JSON.stringify(read.value) };
}

/** Empties the server, seeds the client database and opens an external instance for `account`. */
export async function external(context: JourneyContext, account: "erp_reader" | "erp_writer"): Promise<Session> {
  await begin(context);
  await seedClient(context);
  return open(context, externalConfig(context, account), NO_RETHINKDB);
}

/** Stops the project with Ctrl+C and checks it exited as interrupted. */
export async function stopped(session: Session): Promise<void> {
  const result = await session.context.stop("SIGINT", session.app);
  session.context.expect(result.folder, [interrupted(result)]);
}
