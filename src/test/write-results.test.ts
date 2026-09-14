import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Schema } from "@antelopejs/interface-database";

interface WriteRecord {
  _id: string;
  value: string;
  errors?: number;
  first_error?: string;
}

interface WriteTables {
  records: WriteRecord;
}

const schema = new Schema<WriteTables>("test-write-results", {
  records: { fields: { value: "string" }, indexes: {} },
});
const owner = schema.instance("owner").table("records");
const other = schema.instance("other").table("records");

describe("Write acknowledgements and scoped primary keys", () => {
  before(async () => {
    await schema.createInstance("owner").run();
    await schema.createInstance("other").run();
  });

  after(async () => {
    await schema.destroyInstance("owner").run();
    await schema.destroyInstance("other").run();
  });

  it("rejects duplicate primary keys", rejectDuplicate);
  it("rejects cross-instance duplicates", rejectCrossInstanceDuplicate);
  it("isolates scoped get writes and reads", isolateScopedGet);
  it("preserves ordinary write-error fields", readErrorFields);
  it("propagates update errors", rejectUpdate);
});

async function rejectDuplicate() {
  const key = randomUUID();
  await owner.insert({ _id: key, value: "original" }).run();
  await assert.rejects(
    owner.insert({ _id: key, value: "duplicate" }).run(),
    /Duplicate primary key/,
  );
  assert.equal((await owner.get(key).run()).value, "original");
}

async function rejectCrossInstanceDuplicate() {
  const key = randomUUID();
  await owner.insert({ _id: key, value: "private" }).run();
  await assert.rejects(
    other.insert({ _id: key, value: "intruder" }).run(),
    /Duplicate primary key/,
  );
  assert.equal(await other.get(key).run(), undefined);
  assert.equal((await owner.get(key).run()).value, "private");
}

async function isolateScopedGet() {
  const key = randomUUID();
  await owner.insert({ _id: key, value: "private" }).run();
  assert.equal(await other.get(key).update({ value: "intruder" }).run(), 0);
  assert.equal(await other.get(key).replace({ value: "intruder" }).run(), 0);
  assert.equal(await other.get(key).delete().run(), 0);
  assert.equal(await other.get(randomUUID()).run(), undefined);
  assert.equal((await owner.get(key).run()).value, "private");
}

async function readErrorFields() {
  const key = randomUUID();
  await owner
    .insert({ _id: key, value: "data", errors: 1, first_error: "data" })
    .run();
  assert.equal((await owner.get(key).run()).errors, 1);
}

async function rejectUpdate() {
  const key = randomUUID();
  await owner.insert({ _id: key, value: "original" }).run();
  await assert.rejects(owner.get(key).update({ _id: randomUUID() }).run());
  assert.equal((await owner.get(key).run()).value, "original");
}
