import { expect } from "chai";
import type { Schema } from "@antelopejs/interface-database/schema";

import { type ErpTables, Native, RegisterErp } from "./erp";
import { CustomerId } from "./fixture";

const ID = "lookup-by-list";

let erp: Schema<ErpTables>;

function Customers() {
  return erp.instance().table("customers");
}

async function LookedUp(tags: string[], otherKey: string) {
  await Native((table) => table("customers").insert({ id: ID, tags }));
  const found = await Customers()
    .get(ID)
    .lookup(Customers(), "tags", otherKey)
    .run();
  return found?.tags;
}

async function PlainReads() {
  return Promise.all(
    [CustomerId(1), CustomerId(2)].map((id) => Customers().get(id).run()),
  );
}

describe("lookup of an external field holding a list of keys", () => {
  before(async () => {
    erp = await RegisterErp();
  });

  afterEach(async () => {
    await Native((table) => table("customers").get(ID).delete());
  });

  it("replaces the list with the rows its primary keys name", async () => {
    const rows = await LookedUp([CustomerId(2), CustomerId(1)], "_id");
    expect(rows).to.have.deep.members(await PlainReads());
  });

  it("replaces the list with the rows a native index finds", async () => {
    const emails = ["user2@example.com", "user1@example.com"];
    const rows = await LookedUp(emails, "email");
    expect(rows).to.have.deep.members(await PlainReads());
  });
});
