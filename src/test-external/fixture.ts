import { type Connection, r } from "rethinkdb-ts";

/**
 * The client database the external suite reads: created by its owner before the module constructs,
 * and never by the adapter. Every value is derived from the row number, so a test can state its
 * expected answer as a native query over the same rows.
 */
export const CLIENT_DATABASE = "erp_test";

const READER_USER = "erp_reader";

export const WRITER_USER = "erp_writer";

export const ACCOUNT_PASSWORD = "erp-password";

export const SERVER = { host: "127.0.0.1", port: 28015 };

const CUSTOMER_COUNT = 500;
const PRODUCT_COUNT = 300;
const ORDER_COUNT = 2000;
const ORDER_LINE_COUNT = 200;
const EVENT_COUNT = 100_000;
const EVENT_BATCH = 10_000;
const SEGMENTS = ["retail", "wholesale", "partner", "internal"];
const STATUSES = ["draft", "paid", "shipped", "cancelled"];
const CITIES = ["Paris", "Lyon", "Lille"];
const CUSTOMERS_START = Date.UTC(2024, 0, 1);
const ORDERS_START = Date.UTC(2025, 0, 1);
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WRITABLE_TABLES = ["customers", "orders", "order_lines"];

function Uuid(prefix: string, index: number): string {
  return `${prefix}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

export function CustomerId(index: number): string {
  return Uuid("0c000000", index);
}

export function OrderId(index: number): string {
  return Uuid("0d000000", index);
}

function Sku(index: number): string {
  return `SKU-${String(index).padStart(5, "0")}`;
}

function Range<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => make(index));
}

interface CustomerRow {
  [field: string]: string | Date | string[] | { city: string };
}

function Customer(index: number): CustomerRow {
  const customer: CustomerRow = {
    id: CustomerId(index),
    name: `Customer ${index}`,
    email: `user${index}@example.com`,
    segment: SEGMENTS[index % SEGMENTS.length],
    created_at: new Date(CUSTOMERS_START + index * 5 * HOUR_MS),
    tags: index % 3 ? ["vip"] : [],
  };
  if (index % 10) {
    customer.address = { city: CITIES[index % CITIES.length] };
  }
  if (index % 11 === 0) {
    delete customer.segment;
  }
  if (index % 7 === 0) {
    customer.phone = `+33 6 ${String(index).padStart(8, "0")}`;
  }
  return customer;
}

function Order(index: number) {
  return {
    id: OrderId(index),
    customer_id: CustomerId((index * 7) % CUSTOMER_COUNT),
    status: STATUSES[index % STATUSES.length],
    ordered_at: new Date(ORDERS_START + (index % 365) * DAY_MS),
    total: ((index * 37) % 100000) / 100,
    note: index % 4 === 0 ? "x".repeat(300) : null,
  };
}

async function SeedTables(connection: Connection) {
  const db = r.db(CLIENT_DATABASE);
  await db.tableCreate("customers").run(connection);
  await db.tableCreate("products", { primaryKey: "sku" }).run(connection);
  await db.tableCreate("products_mixed", { primaryKey: "sku" }).run(connection);
  await db.tableCreate("orders").run(connection);
  await db.tableCreate("order_lines").run(connection);
  await db.tableCreate("events").run(connection);
  await db
    .table("customers")
    .insert(Range(CUSTOMER_COUNT, Customer))
    .run(connection);
  await db
    .table("products")
    .insert([
      ...Range(PRODUCT_COUNT, (index) => ({
        sku: Sku(index),
        label: `Product ${index}`,
        price: index * 10 + 0.5,
        active: index % 9 !== 0,
      })),
      { sku: "SKU-legacy", label: "Legacy", price: "12", active: "yes" },
    ])
    .run(connection);
  await db
    .table("products_mixed")
    .insert([
      { sku: "SKU-1", label: "text key" },
      { sku: 42, label: "numeric key" },
    ])
    .run(connection);
  await db.table("orders").insert(Range(ORDER_COUNT, Order)).run(connection);
  await db
    .table("order_lines")
    .insert(
      Range(ORDER_LINE_COUNT, (index) => ({
        id: [OrderId(index), 1],
        sku: Sku(index % PRODUCT_COUNT),
        qty: 1 + (index % 5),
      })),
    )
    .run(connection);
}

async function SeedIndexes(connection: Connection) {
  const db = r.db(CLIENT_DATABASE);
  await db.table("customers").indexCreate("email").run(connection);
  await db
    .table("customers")
    .indexCreate("tags", { multi: true })
    .run(connection);
  await db
    .table("customers")
    .indexCreate("lower_name", r.row("name").downcase())
    .run(connection);
  await db.table("orders").indexCreate("customer_id").run(connection);
  await db.table("customers").indexCreate("segment").run(connection);
  await db
    .table("orders")
    .indexCreate("status_ordered", [r.row("status"), r.row("ordered_at")])
    .run(connection);
  await db.table("customers").indexWait().run(connection);
  await db.table("orders").indexWait().run(connection);
}

async function SeedEvents(connection: Connection) {
  for (let start = 0; start < EVENT_COUNT; start += EVENT_BATCH) {
    await r
      .db(CLIENT_DATABASE)
      .table("events")
      .insert(
        Range(EVENT_BATCH, (offset) => ({
          kind: STATUSES[(start + offset) % STATUSES.length],
          n: (start + offset) % 997,
        })),
        { durability: "soft" },
      )
      .run(connection);
  }
}

async function CreateAccounts(connection: Connection) {
  const users = r.db("rethinkdb").table("users");
  for (const user of [READER_USER, WRITER_USER]) {
    await users.get(user).delete().run(connection);
    await users
      .insert({ id: user, password: ACCOUNT_PASSWORD })
      .run(connection);
    await r.db(CLIENT_DATABASE).grant(user, { read: true }).run(connection);
  }
  for (const table of WRITABLE_TABLES) {
    await r
      .db(CLIENT_DATABASE)
      .table(table)
      .grant(WRITER_USER, { read: true, write: true })
      .run(connection);
  }
}

/** A connection as the client database's owner, for assertions the module cannot make. */
export function AdminConnection(): Promise<Connection> {
  return r.connect(SERVER);
}

/** Builds the client database as its owner would, with a reader and a writer account. */
export async function SeedClientDatabase() {
  const connection = await AdminConnection();
  try {
    if ((await r.dbList().run(connection)).includes(CLIENT_DATABASE)) {
      await r.dbDrop(CLIENT_DATABASE).run(connection);
    }
    await r.dbCreate(CLIENT_DATABASE).run(connection);
    await SeedTables(connection);
    await SeedIndexes(connection);
    await SeedEvents(connection);
    await CreateAccounts(connection);
  } finally {
    await connection.close();
  }
}
