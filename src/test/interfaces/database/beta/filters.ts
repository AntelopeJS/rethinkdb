import { Schema, ValueProxy } from "@ajs/database/beta";
import { expect } from "chai";
import { getUniqueUsers, User } from "../../../datasets/users";

const tableName = "test-table";
const schema = new Schema<{ [tableName]: User }>("test-filters", {
  [tableName]: User,
});
const table = schema.instance("default").table(tableName);

// Utiliser le dataset unifié
const testData = getUniqueUsers();

let insertedKeys: string[] = [];

describe("Filter Operations", () => {
  before(async () => {
    await schema.createInstance("default").run();
  });

  after(async () => {
    await table.delete().run();
    await schema.destroyInstance("default").run();
  });

  it("Insert Test Data", InsertTestData);
  it("Filter by String Equality", FilterByStringEquality);
  it("Filter by Number Comparison", FilterByNumberComparison);
  it("Filter by Boolean", FilterByBoolean);
  it("Filter with Constant String", FilterWithConstantString);
  it("Filter with Constant Number", FilterWithConstantNumber);
  it("Filter with Constant Array", FilterWithConstantArray);
  it("Filter with Array Field Filter", FilterWithArrayFieldFilter);
  it("Filter with Array Field Map", FilterWithArrayFieldMap);
  it("Cleanup", CleanupTest);
});

async function InsertTestData() {
  const response = await table.insert(testData).run();
  expect(response).to.be.an("array");

  expect(response).to.have.lengthOf(testData.length);
  response.forEach((val) => {
    expect(val).to.be.a("string");
  });
  insertedKeys = response;
}

async function FilterByStringEquality() {
  const result = await table
    .filter((doc) => doc.key("department").eq("Development"))
    .run();

  expect(result).to.be.an("array");
  const expectedCount = testData.filter(
    (user) => user.department === "Development",
  ).length;
  expect(result).to.have.lengthOf(expectedCount);

  result.forEach((doc) => {
    expect(doc.department).to.equal("Development");
  });

  const names = result.map((doc) => doc.name).sort();
  expect(names).to.deep.equal(["Antoine", "Camille", "Emilie"]);
}

async function FilterByNumberComparison() {
  const result = await table.filter((doc) => doc.key("age").gt(25)).run();

  expect(result).to.be.an("array");
  const expectedCount = testData.filter((user) => user.age > 25).length;
  expect(result).to.have.lengthOf(expectedCount);

  result.forEach((doc) => {
    expect(doc.age).to.be.greaterThan(25);
  });

  const ages = result.map((doc) => doc.age).sort();
  expect(ages).to.deep.equal([28, 30, 35]);
}

async function FilterByBoolean() {
  const result = await table
    .filter((doc) => doc.key("isActive").eq(true))
    .run();

  expect(result).to.be.an("array");
  const expectedCount = testData.filter(
    (user) => user.isActive === true,
  ).length;
  expect(result).to.have.lengthOf(expectedCount);

  result.forEach((doc) => {
    expect(doc.isActive).to.equal(true);
  });

  const names = result.map((doc) => doc.name).sort();
  expect(names).to.deep.equal(["Antoine", "Camille", "Dominique", "Emilie"]);
}

async function FilterWithConstantString() {
  const result = await table
    .filter((doc) =>
      doc.key("department").eq(ValueProxy.constant("Development")),
    )
    .run();

  expect(result).to.be.an("array");
  const expectedCount = testData.filter(
    (user) => user.department === "Development",
  ).length;
  expect(result).to.have.lengthOf(expectedCount);

  result.forEach((doc) => {
    expect(doc.department).to.equal("Development");
  });

  const names = result.map((doc) => doc.name).sort();
  expect(names).to.deep.equal(["Antoine", "Camille", "Emilie"]);
}

async function FilterWithConstantNumber() {
  const result = await table
    .filter((doc) => doc.key("age").gt(ValueProxy.constant(25)))
    .run();

  expect(result).to.be.an("array");
  const expectedCount = testData.filter((user) => user.age > 25).length;
  expect(result).to.have.lengthOf(expectedCount);

  result.forEach((doc) => {
    expect(doc.age).to.be.greaterThan(25);
  });

  const ages = result.map((doc) => doc.age).sort();
  expect(ages).to.deep.equal([28, 30, 35]);
}

async function FilterWithConstantArray() {
  const departments = ["Development", "Marketing"];
  const result = await table
    .filter((doc) =>
      ValueProxy.constant(departments).includes(doc.key("department")),
    )
    .run();

  expect(result).to.be.an("array");
  const expectedCount = testData.filter((user) =>
    departments.includes(user.department ?? ""),
  ).length;
  expect(result).to.have.lengthOf(expectedCount);

  result.forEach((doc) => {
    expect(departments).to.include(doc.department);
  });

  const names = result.map((doc) => doc.name).sort();
  expect(names).to.deep.equal(["Alice", "Antoine", "Camille", "Emilie"]);
}

async function FilterWithArrayFieldFilter() {
  const targetSkills = ["JavaScript", "Python"];
  const result = await table
    .filter((doc) =>
      doc
        .key("skills")
        .filter((skill) => ValueProxy.constant(targetSkills).includes(skill))
        .count()
        .gt(0),
    )
    .run();

  expect(result).to.be.an("array");
  const expectedNames = testData
    .filter((user) => (user.skills ?? []).some((s) => targetSkills.includes(s)))
    .map((u) => u.name)
    .sort();
  expect(result).to.have.lengthOf(expectedNames.length);

  const names = result.map((doc) => doc.name).sort();
  expect(names).to.deep.equal(expectedNames);
}

async function FilterWithArrayFieldMap() {
  const result = await table
    .filter((doc) => doc.key("skills").count().gt(0))
    .map((doc) => ({
      name: doc.key("name"),
      upperSkills: doc.key("skills").map((skill) => skill.upcase()),
    }))
    .run();

  expect(result).to.be.an("array");
  for (const doc of result) {
    expect(doc.upperSkills).to.be.an("array");
    for (const skill of doc.upperSkills) {
      expect(skill).to.equal(skill.toUpperCase());
    }
  }
}

async function CleanupTest() {
  for (const key of insertedKeys) {
    await table.get(key).delete().run();
  }
}
