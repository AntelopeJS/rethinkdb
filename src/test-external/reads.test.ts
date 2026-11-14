import { expect } from "chai";
import { r, type RDatum } from "rethinkdb-ts";
import {
  CROSS_INSTANCE,
  type Schema,
} from "@antelopejs/interface-database/schema";

import { GetOptions } from "../config";
import { type ErpTables, Native, RegisterErp } from "./erp";
import { AdminConnection, CustomerId, OrderId } from "./fixture";

const DAY_MS = 86_400_000;
const SHORT_TIMEOUT_MS = 50;
const SLOW_READ_ROWS = 20_000;
const LONG_TIMEOUT_MS = 30_000;
const SETTLE_MS = 200;

let erp: Schema<ErpTables>;

function Table(name: string) {
  return erp.instance().table(name);
}

async function Refusal<T>(work: () => PromiseLike<T>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the request was expected to be refused");
}

describe("reading an external RethinkDB table by key", () => {
  before(async () => {
    erp = await RegisterErp();
  });

  for (const table of ["customers", "products", "order_lines"]) {
    it(`gets each ${table} row back by the _id a list answered`, async () => {
      const rows = await Table(table).orderBy("_id").slice(0, 3).run();
      expect(rows).to.have.length(3);
      const ids = rows
        .map((row) => row._id)
        .filter((id): id is string => id?.constructor === String);
      expect(ids).to.have.length(3);
      for (const [position, row] of rows.entries()) {
        expect(await Table(table).get(ids[position]).run()).to.deep.equal(row);
      }
    });
  }

  it("answers order_lines' compound key as JSON text", async () => {
    const [row] = await Table("order_lines").orderBy("_id").slice(0, 1).run();
    expect(row._id).to.equal(JSON.stringify([OrderId(0), 1]));
  });

  for (const [table, key] of [
    ["customers", "nope"],
    ["order_lines", "[bad"],
    ["order_lines", '"text"'],
  ]) {
    it(`answers not found for the key ${key} on ${table}, rather than an error`, async () => {
      expect(await Table(table).get(key).run()).to.equal(undefined);
    });
  }

  it("registers a table whose keys mix types without _id, and refuses _id declared on it", async () => {
    const rows = await Table("products_mixed").run();
    expect(rows.every((row) => !("_id" in row))).to.equal(true);
    const message = await Refusal(() =>
      RegisterErp(
        { products_mixed: { fields: { _id: "string" }, indexes: {} } },
        "erp_mixed",
      ),
    );
    expect(message).to.contain("has no usable _id");
  });
});

describe("the values an external RethinkDB table answers", () => {
  before(async () => {
    erp = await RegisterErp();
  });

  it("reads a value of a type its declaration does not read as null, and drops undeclared fields", async () => {
    const legacy = await Table("products").get("SKU-legacy").run();
    expect(legacy).to.include({ price: null, active: null, label: "Legacy" });
    const customer = await Table("customers").get(CustomerId(7)).run();
    expect(customer).to.not.have.property("phone");
  });

  it("lists with a filter, a search, a sort and a page, as native ReQL does", async () => {
    const rows = await Table("orders")
      .orderBy("_id", "desc")
      .filter((row) => row.key("status").eq("paid"))
      .filter((row) => row.key("status").match("(?i)PAI"))
      .slice(0, 5)
      .pluck("_id", "status", "total")
      .run();
    const expected = await Native((table) =>
      table("orders")
        .orderBy({ index: r.desc("id") })
        .filter({ status: "paid" })
        .limit(5)
        .map((row) => ({
          _id: row("id"),
          status: row("status"),
          total: row("total"),
        })),
    );
    expect(rows).to.deep.equal(expected);
  });

  it("answers a date filter 'is' as that UTC day", async () => {
    const day = new Date("2025-03-02T00:00:00.000Z");
    const next = new Date(day.getTime() + DAY_MS);
    const total = await Table("orders")
      .filter((row) =>
        row.key("ordered_at").ge(day).and(row.key("ordered_at").lt(next)),
      )
      .count()
      .run();
    const expected = await Native((table) =>
      table("orders")
        .filter((row: RDatum) =>
          row("ordered_at").ge(day).and(row("ordered_at").lt(next)),
        )
        .count(),
    );
    expect(total).to.equal(expected).and.to.be.greaterThan(0);
  });

  it("resolves a relation from orders to customers through the primary key", async () => {
    const rows = await Table("orders")
      .orderBy("_id")
      .slice(0, 2)
      .lookup(Table("customers"), "customer_id", "_id")
      .pluck("_id", "customer_id")
      .run();
    rows.forEach((row, index) =>
      expect(row.customer_id).to.include({
        _id: CustomerId((index * 7) % 500),
        name: `Customer ${(index * 7) % 500}`,
      }),
    );
  });

  it("answers a key no row has through a lookup as a plain read does", async () => {
    const key = "no order has this key";
    const missing = await Table("orders")
      .get(key)
      .lookup(Table("customers"), "customer_id", "_id")
      .run();
    expect(missing).to.equal(await Table("orders").get(key).run());
  });

  it("answers a key no row has through a mapping as a plain read does", async () => {
    const key = "no order has this key";
    const missing = await Table("orders")
      .get(key)
      .do((row) => ({ status: row.key("status") }))
      .run();
    expect(missing).to.equal(await Table("orders").get(key).run());
  });

  it("buckets a builder series by day", async () => {
    const series = await Table("orders")
      .filter((row) =>
        row.key("ordered_at").ge(new Date("2025-03-01T00:00:00Z")),
      )
      .map((row) => ({
        bucket: row
          .key("ordered_at")
          .year()
          .mul(100)
          .add(row.key("ordered_at").month())
          .mul(100)
          .add(row.key("ordered_at").day()),
      }))
      .group("bucket", (rows, group) => ({ x: group, y: rows.count() }))
      .orderBy("x", "asc")
      .slice(0, 3)
      .run();
    expect(series).to.have.length(3);
    expect(series[0]).to.deep.equal({ x: 20250301, y: series[0].y });
  });

  it("reads every row through CROSS_INSTANCE, and refuses a named instance", async () => {
    expect(
      await erp.instance(CROSS_INSTANCE).table("orders").count().run(),
    ).to.equal(await Native((table) => table("orders").count()));
    expect(
      await Refusal(() =>
        erp.instance("tenant-1").table("orders").count().run(),
      ),
    ).to.contain("tenant-1");
  });
});

describe("reads an external RethinkDB table's own indexes serve", () => {
  before(async () => {
    erp = await RegisterErp();
  });

  it("keeps the rows an index order would leave out, those missing the field", async () => {
    const rows = await Table("customers").orderBy("segment").pluck("_id").run();
    expect(rows).to.have.length(await Table("customers").count().run());
  });

  it("matches a multi index by element, and a plain index over the same array by whole value", async () => {
    const tagged = await Table("customers").getAll("vip", "tags").count().run();
    const native = await Native<number>((table) =>
      table("customers")
        .filter((row: RDatum) => row("tags").default([]).contains("vip"))
        .count(),
    );
    expect(tagged).to.be.above(0);
    expect(tagged).to.equal(native);
    expect(
      await Table("customers").getAll("vip", "tag_set").count().run(),
    ).to.equal(0);
  });
});

/**
 * A read the server cannot answer within `SHORT_TIMEOUT_MS`: a lookup of each of the first
 * `SLOW_READ_ROWS` events. The server stops it soon after its connection closes, so a stopped
 * read leaves no work behind to slow the tests after it.
 */
function SlowRead() {
  return Table("events")
    .slice(0, SLOW_READ_ROWS)
    .lookup(Table("customers"), "kind", "_id")
    .count();
}

describe("the time bound of an external RethinkDB read", () => {
  before(async () => {
    erp = await RegisterErp();
  });

  it("abandons a read beyond statementTimeoutMs, and answers timeout", async () => {
    const options = GetOptions();
    const configured = options.statementTimeoutMs;
    options.statementTimeoutMs = SHORT_TIMEOUT_MS;
    try {
      const message = await Refusal(() => SlowRead().run());
      expect(message).to.contain(
        `did not finish within ${SHORT_TIMEOUT_MS} ms`,
      );
    } finally {
      options.statementTimeoutMs = configured;
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const connection = await AdminConnection();
    try {
      const jobs = await r
        .db("rethinkdb")
        .table("jobs")
        .filter({ type: "query" })
        .count()
        .run(connection);
      expect(jobs).to.equal(1);
    } finally {
      await connection.close();
    }
  });

  it("answers the next read after one ran past statementTimeoutMs", async () => {
    const options = GetOptions();
    const configured = options.statementTimeoutMs;
    options.statementTimeoutMs = SHORT_TIMEOUT_MS;
    try {
      await Refusal(() => SlowRead().run());
      options.statementTimeoutMs = LONG_TIMEOUT_MS;
      expect(
        await Table("customers").orderBy("_id").slice(0, 3).run(),
      ).to.have.length(3);
    } finally {
      options.statementTimeoutMs = configured;
    }
  });

  it("keeps reading a cursor past its first batch while another read runs past statementTimeoutMs", async () => {
    const options = GetOptions();
    const configured = options.statementTimeoutMs;
    try {
      options.statementTimeoutMs = LONG_TIMEOUT_MS;
      const total = await Table("orders").count().run();
      const orders = Table("orders").cursor();
      await orders.next();
      options.statementTimeoutMs = SHORT_TIMEOUT_MS;
      expect(await Refusal(() => SlowRead().run())).to.contain(
        `did not finish within ${SHORT_TIMEOUT_MS} ms`,
      );
      let read = 1;
      while (!(await orders.next()).done) {
        read += 1;
      }
      expect(read).to.equal(total);
    } finally {
      options.statementTimeoutMs = configured;
    }
  });

  it("stops a read through a cursor beyond statementTimeoutMs, and answers timeout", async () => {
    const options = GetOptions();
    const configured = options.statementTimeoutMs;
    options.statementTimeoutMs = SHORT_TIMEOUT_MS;
    try {
      const message = await Refusal(async () => {
        const rows = SlowRead().cursor();
        for await (const row of rows) {
          expect(row).to.not.equal(undefined);
        }
      });
      expect(message).to.contain(
        `did not finish within ${SHORT_TIMEOUT_MS} ms`,
      );
    } finally {
      options.statementTimeoutMs = configured;
    }
  });
});
