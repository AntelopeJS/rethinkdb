import { expect } from "chai";
import { r } from "rethinkdb-ts";
import { IsDuplicateKeyError } from "@antelopejs/interface-database";
import type { Schema } from "@antelopejs/interface-database/schema";

import { type ErpRow, type ErpTables, Native, RegisterErp } from "./erp";
import { CustomerId } from "./fixture";

const NEW_PREFIX = "New customer";

let erp: Schema<ErpTables>;

function Customers() {
  return erp.instance().table("customers");
}

function Stored(id: string): Promise<ErpRow | null> {
  return Native<ErpRow | null>((table) => table("customers").get(id));
}

async function Refusal<T>(work: () => PromiseLike<T>): Promise<Error> {
  try {
    await work();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
  }
  throw new Error("the write was expected to be refused");
}

describe("writing to an external RethinkDB table", () => {
  before(async () => {
    erp = await RegisterErp();
  });

  it("replaces nothing when a whole read row comes back unedited, keeping an absent field absent and the undeclared phone", async () => {
    const id = CustomerId(77);
    const before = await Stored(id);
    const row = await Customers().get(id);
    expect(row?.segment).to.equal(null);
    expect(await Customers().get(id).update(row)).to.equal(0);
    expect(await Stored(id)).to.deep.equal(before);
    expect(before).to.not.have.property("segment");
  });

  it("changes only the field edited", async () => {
    const id = CustomerId(21);
    const before = await Stored(id);
    const row = await Customers().get(id);
    expect(
      await Customers()
        .get(id)
        .update({ ...row, name: "Renamed 21" }),
    ).to.equal(1);
    expect(await Stored(id)).to.deep.equal({ ...before, name: "Renamed 21" });
  });

  it("writes nothing when the payload's _id names another row", async () => {
    const id = CustomerId(22);
    expect(
      await Customers()
        .get(id)
        .update({ _id: CustomerId(23), name: "Moved" }),
    ).to.equal(0);
    expect((await Stored(id))?.name).to.equal("Customer 22");
  });

  it("removes the declared fields replace leaves out, and keeps the undeclared ones", async () => {
    const id = CustomerId(28);
    const before = await Stored(id);
    expect(
      await Customers()
        .get(id)
        .replace({ name: "Replaced 28", email: "user28@example.com" }),
    ).to.equal(1);
    const after = await Stored(id);
    expect(after).to.not.have.property("segment");
    expect(after).to.include({ name: "Replaced 28", phone: before?.phone });
  });

  it("lets the server generate uuids, answered in input order", async () => {
    const names = [0, 1, 2].map((index) => `${NEW_PREFIX} ${index}`);
    const ids = await Customers().insert(names.map((name) => ({ name })));
    const stored = await Promise.all(ids.map((id) => Stored(id)));
    expect(stored.map((row) => row?.name)).to.deep.equal(names);
    const deleted = await Customers()
      .filter((row) => row.key("name").match(`^${NEW_PREFIX} `))
      .delete();
    expect(deleted).to.equal(names.length);
  });

  it("refuses an insert without a key into a table whose keys the server does not generate", async () => {
    const error = await Refusal(() =>
      erp.instance().table("products").insert({ label: "No key" }),
    );
    expect(error.message).to.contain("'_id'");
  });

  it("raises DuplicateKeyError on a duplicate key, quoting no row", async () => {
    const error = await Refusal(() =>
      Customers().insert({ _id: CustomerId(1), name: "Twin" }),
    );
    expect(IsDuplicateKeyError(error)).to.equal(true);
    expect(error).to.include({ index: "id" });
    expect(error.message)
      .to.not.contain("example.com")
      .and.to.not.contain("Customer 1");
  });

  it("refuses an undeclared key and an object value by name", async () => {
    expect(
      (
        await Refusal(() =>
          Customers().get(CustomerId(2)).update({ phone: "x" }),
        )
      ).message,
    ).to.contain("'phone'");
    expect(
      (
        await Refusal(() =>
          Customers().insert({ name: "A", address: { city: "Paris" } }),
        )
      ).message,
    ).to.contain("'address'");
  });

  it("answers forbidden for a table the account may not write", async () => {
    const error = await Refusal(() =>
      erp
        .instance()
        .table("products")
        .get("SKU-00001")
        .update({ label: "Changed" }),
    );
    expect(error).to.have.property("kind", "forbidden");
    const product = await Native<ErpRow | null>((table) =>
      table("products").get("SKU-00001"),
    );
    expect(product?.label).to.equal("Product 1");
  });
});

describe("keys and conflicts of an external RethinkDB table", () => {
  before(async () => {
    erp = await RegisterErp();
  });

  it("never runs key text as a query, and stores a key with a nested array", async () => {
    const lines = erp.instance().table("order_lines");
    const before = await Customers().count();
    const term = '[[54,[[15,[[14,["erp_test"]],"customers"]]]],1]';
    expect(await lines.get(term)).to.equal(undefined);
    expect(await Customers().count()).to.equal(before);
    const [nested] = await lines.insert({
      _id: '[["n",1],2]',
      sku: "S",
      qty: 1,
    });
    expect(nested).to.equal('[["n",1],2]');
    expect((await lines.get(nested))?._id).to.equal(nested);
  });

  it("writes a field sent as null on a conflicting insert, under either mode", async () => {
    for (const [index, conflict] of [
      [74, "update"],
      [75, "replace"],
    ] as const) {
      const id = CustomerId(index);
      expect(await Stored(id)).to.have.property("segment");
      await Customers().insert({ _id: id, segment: null }, { conflict });
      expect(await Stored(id)).to.have.property("segment", null);
    }
  });

  it("removes the fields a replace leaves out from every row it selected by another field", async () => {
    const orders = erp.instance().table("orders");
    const customer = CustomerId(4);
    const ids = (await orders.getAll(customer, "customer_id").pluck("_id")).map(
      // SAFETY: orders are uuid-keyed, so each _id a read answers is its text.
      (row) => row._id as string,
    );
    const noted = await Native<number>((table) =>
      table("orders").getAll(r.args(ids)).hasFields("note").count(),
    );
    expect(noted).to.be.above(0);
    await orders.getAll(customer, "customer_id").replace({
      customer_id: CustomerId(5),
      status: "paid",
      total: 1,
      ordered_at: new Date("2026-01-01T00:00:00Z"),
    });
    for (const id of ids) {
      const stored = await Native<ErpRow | null>((table) =>
        table("orders").get(id),
      );
      expect(stored).to.not.have.property("note");
      expect(stored).to.include({ customer_id: CustomerId(5) });
    }
  });

  it("inserts under a compound key, given as _id text or as the key field, and answers its JSON text", async () => {
    const lines = erp.instance().table("order_lines");
    const [byId] = await lines.insert({ _id: '["o-new",1]', sku: "S", qty: 2 });
    expect(byId).to.equal('["o-new",1]');
    expect((await lines.get(byId))?._id).to.equal(byId);
    const [byField] = await lines.insert({
      id: ["o-new", 2],
      sku: "S",
      qty: 1,
    });
    expect(byField).to.equal('["o-new",2]');
  });

  it("refuses a key of another type than the table's, and a date for a string field", async () => {
    const lines = erp.instance().table("order_lines");
    const key = await Refusal(() =>
      lines.insert({ _id: "plain", sku: "S", qty: 1 }),
    );
    expect(key.message).to.contain("'_id'").and.to.contain("array");
    const date = await Refusal(() => Customers().insert({ name: new Date() }));
    expect(date.message).to.contain("'name'");
  });

  it("merges declared fields on a conflicting insert, keeping the undeclared phone", async () => {
    const id = CustomerId(70);
    const before = await Stored(id);
    expect(before).to.have.property("phone");
    await Customers().insert(
      { _id: id, name: "Merged 70" },
      { conflict: "replace" },
    );
    const after = await Stored(id);
    expect(after).to.include({ name: "Merged 70", phone: before?.phone });
    expect(after).to.not.have.property("email");
  });
});
