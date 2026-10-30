import assert from "node:assert/strict";

import { IsNumber, IsText } from "../implementations/database/utils";

const NULL_PROTOTYPE: unknown = Object.create(null);

describe("Primitive guards on the constructor", () => {
  it("accept primitives and their boxed forms of the matching constructor", () => {
    assert.equal(IsText("42"), true);
    assert.equal(IsText(new String("42")), true);
    assert.equal(IsNumber(42), true);
    assert.equal(IsNumber(new Number(42)), true);
  });

  it("reject other constructors, absent values and unprototyped objects", () => {
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
    for (const value of ["42", true, null, undefined, [], {}, NULL_PROTOTYPE]) {
      assert.equal(IsNumber(value), false);
    }
  });

  it("read an own constructor key as the constructor", () => {
    assert.equal(IsText({ constructor: String }), true);
    assert.equal(IsText({ constructor: "String" }), false);
    assert.equal(IsNumber({ constructor: Number }), true);
  });
});
