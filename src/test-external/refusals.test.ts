import { expect } from "chai";
import { Schema } from "@antelopejs/interface-database/schema";

import { Schemas } from "../implementations/database/schema";
import { type ErpTables, RegisterErp } from "./erp";
import { CustomerId } from "./fixture";

let erp: Schema<ErpTables>;

async function Refusal<T>(work: () => PromiseLike<T>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the request was expected to be refused");
}

async function FirstEvent<T>(
  feed: AsyncIterable<T>,
): Promise<IteratorResult<T>> {
  const iterator = feed[Symbol.asyncIterator]();
  try {
    return await iterator.next();
  } finally {
    await iterator.return?.();
  }
}

describe("what an external RethinkDB table refuses", () => {
  before(async () => {
    erp = await RegisterErp();
  });

  it("refuses changes(), since the adapter reads no feed of the client's database", async () => {
    const message = await Refusal(() =>
      FirstEvent(erp.instance().table("orders").changes()),
    );
    expect(message).to.contain("changes()").and.to.contain("orders");
  });

  it("refuses atomicMutation, naming the table", async () => {
    const message = await Refusal(() =>
      erp.instance().table("customers").atomicMutation(CustomerId(1), {
        type: "update",
        revisionField: "name",
        expectedRevision: "Customer 1",
        nextRevision: "Customer one",
        patch: {},
      }),
    );
    expect(message).to.contain("atomicMutation").and.to.contain("customers");
  });

  it("refuses creating and destroying an instance, and lists none", async () => {
    expect(await Refusal(() => erp.createInstance("t1"))).to.contain(
      "createInstance",
    );
    expect(await Refusal(() => erp.destroyInstance("t1"))).to.contain(
      "destroyInstance",
    );
    expect(await erp.listInstances()).to.deep.equal([]);
  });

  it("refuses get on a table whose keys mix types, naming it", async () => {
    const message = await Refusal(() =>
      erp.instance().table("products_mixed").get("42"),
    );
    expect(message).to.contain("products_mixed").and.to.contain("no _id");
  });
});

describe("an external schema whose registration fails", () => {
  it("registers, then fails every query on it with the registration message", async () => {
    const definition = { ghost: { fields: { a: "string" }, indexes: {} } };
    await Schemas.register("erp_ghost", definition);
    const ghost = new Schema("erp_ghost", definition);
    const message = await Refusal(() => ghost.instance().table("ghost"));
    expect(message).to.contain(
      "Table 'erp_ghost.ghost' reads table ghost, which database",
    );
  });
});
