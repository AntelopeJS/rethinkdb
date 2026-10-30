import assert from "node:assert/strict";

import { IsNumber, IsText } from "../implementations/database/utils";

const NULL_PROTOTYPE: unknown = Object.create(null);

describe("Primitive guards", () => {
  it("accept primitives", () => {
    assert.equal(IsText("42"), true);
    assert.equal(IsText(""), true);
    assert.equal(IsNumber(42), true);
    assert.equal(IsNumber(Number.NaN), true);
  });

  it("reject boxed values and objects forging a constructor", () => {
    assert.equal(IsText(new String("42")), false);
    assert.equal(IsNumber(new Number(42)), false);
    assert.equal(IsText({ constructor: String }), false);
    assert.equal(IsNumber({ constructor: Number }), false);
  });

  it("reject other types, absent values and unprototyped objects", () => {
    for (const value of [
      42,
      true,
      null,
      undefined,
      [],
      {},
      new Date(),
      NULL_PROTOTYPE,
    ]) {
      assert.equal(IsText(value), false);
    }
    for (const value of [
      "42",
      true,
      null,
      undefined,
      [],
      {},
      new Date(),
      NULL_PROTOTYPE,
    ]) {
      assert.equal(IsNumber(value), false);
    }
  });
});
