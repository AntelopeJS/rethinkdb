import { expect } from "chai";
import { r } from "rethinkdb-ts";
import {
  DescribeRelations,
  Info,
  ListRelations,
  Profile,
  SampleRows,
} from "@antelopejs/interface-database-catalog";

import {
  SetMeasureTimeoutForTests,
  SetSampleThresholdForTests,
} from "../implementations/catalog/measures";
import { AdminConnection, CLIENT_DATABASE, WRITER_USER } from "./fixture";

const UUID_KEYED_ROWS = 1000;
const CATALOG_TIMEOUT_MS = 60_000;

function Relation(name: string): string {
  return `${CLIENT_DATABASE}.${name}`;
}

describe("the catalog of an external RethinkDB instance", function () {
  this.timeout(CATALOG_TIMEOUT_MS);

  it("answers the engine, the database and the connected account", async () => {
    expect(await Info()).to.include({
      engine: "rethinkdb",
      database: CLIENT_DATABASE,
      role: WRITER_USER,
    });
  });

  it("lists each table's primary key, none for one whose keys mix types, and writes nothing to learn its privileges", async () => {
    const connection = await AdminConnection();
    const feed = await r
      .db(CLIENT_DATABASE)
      .table("products")
      .changes()
      .run(connection);
    try {
      const relations = await ListRelations();
      const keys = Object.fromEntries(
        relations.map((relation) => [relation.name, relation.key]),
      );
      expect(keys.customers).to.deep.equal({
        columns: ["id"],
        source: "primary",
      });
      expect(keys.products).to.deep.equal({
        columns: ["sku"],
        source: "primary",
      });
      expect(keys.order_lines).to.deep.equal({
        columns: ["id"],
        source: "primary",
      });
      expect(keys.products_mixed).to.equal(null);
      const writes = Object.fromEntries(
        relations.map((relation) => [relation.name, relation.writes]),
      );
      expect(writes.customers).to.deep.equal({
        insert: true,
        update: true,
        delete: true,
      });
      expect(writes.products).to.deep.equal({
        insert: false,
        update: false,
        delete: false,
      });
      const pending: unknown[] = [];
      void feed.each((_error, change) => {
        pending.push(change);
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(pending).to.deep.equal([]);
    } finally {
      await feed.close();
      await connection.close();
    }
  });

  it("describes index columns: none for a function index, two for a compound one", async () => {
    const [customers, orders] = await DescribeRelations([
      Relation("customers"),
      Relation("orders"),
    ]);
    const lower = customers.indexes.find(
      (index) => index.name === "lower_name",
    );
    const ordered = orders.indexes.find(
      (index) => index.name === "status_ordered",
    );
    expect(lower?.columns).to.deep.equal([]);
    expect(ordered?.columns).to.deep.equal(["status", "ordered_at"]);
    const price = (
      await DescribeRelations([Relation("products")])
    )[0].columns.find((column) => column.name === "price");
    expect(price?.accepts[0].declared).to.equal("number");
    expect(price?.accepts[0].lossy).to.contain("1 of 301 values are STRING");
  });
});

describe("the profiles and samples of an external RethinkDB catalog", function () {
  this.timeout(CATALOG_TIMEOUT_MS);

  it("profiles without naming an email, and samples a uuid-keyed table the same way twice", async () => {
    const customers = await Profile({ relation: Relation("customers") });
    expect(JSON.stringify(customers)).to.not.contain("example.com");
    SetSampleThresholdForTests(UUID_KEYED_ROWS / 10);
    try {
      const first = await SampleRows({
        relation: Relation("events"),
        columns: ["n"],
        limit: 20,
      });
      const second = await SampleRows({
        relation: Relation("events"),
        columns: ["n"],
        limit: 20,
      });
      expect(first.sample).to.not.equal(null);
      expect(second.rows).to.deep.equal(first.rows);
    } finally {
      SetSampleThresholdForTests();
    }
  });

  it("answers timeout for a measure that runs out of time, and answers again once it has time", async () => {
    SetMeasureTimeoutForTests(1);
    try {
      const slow = await Profile({
        relation: Relation("events"),
        columns: ["kind"],
      }).catch((error: unknown) =>
        error instanceof Error ? error.message : error,
      );
      expect(JSON.stringify(slow)).to.contain("timeout");
    } finally {
      SetMeasureTimeoutForTests();
    }
    const again = await Profile({
      relation: Relation("events"),
      columns: ["kind"],
    });
    expect(again.columns[0].distinct).to.deep.equal({ status: "ok", value: 4 });
  });

  it("samples rows as text cut at 200 characters", async () => {
    const sample = await SampleRows({
      relation: Relation("orders"),
      columns: ["note"],
      limit: 20,
    });
    expect(sample.rows.map(([note]) => note)).to.deep.include({
      text: "x".repeat(200),
      truncated: true,
    });
  });
});
