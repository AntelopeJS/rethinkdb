import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  type DuplicateKeyError,
  IsDuplicateKeyError,
  Schema,
} from "@antelopejs/interface-database";

interface WriteRecord {
  _id: string;
  id?: string;
  value: string;
  errors?: number;
  first_error?: string;
  stage?: string;
  args?: string[];
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

  it(
    "rejects duplicate primary keys with a DuplicateKeyError",
    rejectDuplicate,
  );
  it("rejects cross-instance duplicates", rejectCrossInstanceDuplicate);
  it("isolates scoped get writes and reads", isolateScopedGet);
  it("preserves ordinary write-error fields", readErrorFields);
  it("propagates update errors", rejectUpdate);
  it(
    "stores a document whose stage field reads func on an update",
    storeFuncStageDocument,
  );
  it("resolves insert to the provided and generated keys", answerInsertKeys);
  it(
    "resolves a conflict insert to the primary key, not an id field",
    answerConflictInsertKeys,
  );
});

function isPrimaryKeyDuplicate(error: unknown): error is DuplicateKeyError {
  return (
    IsDuplicateKeyError(error) &&
    error.index === "_id" &&
    error.fields.length === 1 &&
    error.fields[0] === "_id"
  );
}

async function rejectDuplicate() {
  const key = randomUUID();
  await owner.insert({ _id: key, value: "original" }).run();
  await assert.rejects(
    owner.insert({ _id: key, value: "duplicate" }).run(),
    isPrimaryKeyDuplicate,
  );
  assert.equal((await owner.get(key).run()).value, "original");
}

async function rejectCrossInstanceDuplicate() {
  const key = randomUUID();
  await owner.insert({ _id: key, value: "private" }).run();
  await assert.rejects(
    other.insert({ _id: key, value: "intruder" }).run(),
    isPrimaryKeyDuplicate,
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

async function storeFuncStageDocument() {
  const key = randomUUID();
  const withArgs = randomUUID();
  await owner.insert({ _id: key, value: "draft", stage: "draft" }).run();
  await owner.insert({ _id: withArgs, value: "draft" }).run();
  await owner.get(key).update({ stage: "func" }).run();
  await owner
    .get(withArgs)
    .update({ stage: "func", args: ["a", "b"] })
    .run();
  const stored = await owner.get(key).run();
  const storedWithArgs = await owner.get(withArgs).run();
  assert.deepEqual([stored.stage, stored.value], ["func", "draft"]);
  assert.deepEqual(
    [storedWithArgs.stage, storedWithArgs.args],
    ["func", ["a", "b"]],
  );
}

async function answerInsertKeys() {
  const provided = randomUUID();
  assert.deepEqual(await owner.insert({ _id: provided, value: "one" }).run(), [
    provided,
  ]);
  const second = randomUUID();
  const keys = await owner
    .insert([{ _id: second, value: "two" }, { value: "generated" }])
    .run();
  assert.equal(keys.length, 2);
  assert.equal(keys[0], second);
  assert.equal((await owner.get(keys[1]).run()).value, "generated");
}

async function answerConflictInsertKeys() {
  const keys = await owner
    .insert({ id: "not-the-key", value: "conflict" }, { conflict: "update" })
    .run();
  assert.equal(keys.length, 1);
  assert.notEqual(keys[0], "not-the-key");
  assert.equal((await owner.get(keys[0]).run()).value, "conflict");
}
