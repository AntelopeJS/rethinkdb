import { expect } from "chai";
import { r } from "rethinkdb-ts";
import {
  type Categories,
  Profile,
  type RelationProfile,
} from "@antelopejs/interface-database-catalog";

import { SetSampleThresholdForTests } from "../implementations/catalog/measures";
import { CategoriesOf } from "../implementations/catalog/profile";
import { Native } from "./erp";
import { CLIENT_DATABASE } from "./fixture";
import { Received } from "./received";

const CATEGORY_LIMIT = 25;
const CATEGORY_MIN_ROWS = 5;
const TALLIES = `${CLIENT_DATABASE}.tallies`;

/** The categories the profile answered when the driver folded them, from the same rows. */
async function Reference(column: string): Promise<Categories> {
  const rows = await Native<[string, number][]>((table) =>
    table("tallies")(column)
      .group((value) => value)
      .count()
      .ungroup()
      .orderBy(r.desc("reduction"), "group")
      .limit(CATEGORY_LIMIT + 1)
      .map((group) => [group("group"), group("reduction")]),
  );
  return {
    values: rows
      .filter(([, count]) => count >= CATEGORY_MIN_ROWS)
      .slice(0, CATEGORY_LIMIT)
      .map(([value, count]) => ({ value, rows: count })),
    other: rows
      .filter(
        ([, count], index) =>
          count < CATEGORY_MIN_ROWS || index >= CATEGORY_LIMIT,
      )
      .reduce((total, [, count]) => total + count, 0),
  };
}

function CategoriesIn(profile: RelationProfile): Categories {
  const categories = profile.columns[0]?.categories;
  expect(categories?.status).to.equal("ok");
  return categories?.status === "ok"
    ? categories.value
    : { values: [], other: 0 };
}

describe("the categories of an external RethinkDB column", function () {
  this.timeout(60_000);

  it("names the values seen in 5 rows or more, as the driver did, and receives no rarer value", async () => {
    const { answer, received } = await Received(() =>
      Profile({ relation: TALLIES, columns: ["label"] }),
    );
    expect(answer.sample).to.equal(null);
    expect(CategoriesIn(answer)).to.deep.equal({
      values: [
        { value: "common", rows: 190 },
        { value: "five", rows: 5 },
      ],
      other: 5,
    });
    expect(CategoriesIn(answer)).to.deep.equal(await Reference("label"));
    expect(received).to.include('"five"');
    expect(received).to.not.include('"four"');
    expect(received).to.not.include('"lone"');
  });

  it("folds the rare values of a sample on the server too", async () => {
    SetSampleThresholdForTests(10);
    try {
      const { answer, received } = await Received(() =>
        Profile({ relation: TALLIES, columns: ["label"] }),
      );
      expect(answer.sample).to.not.equal(null);
      expect(CategoriesIn(answer)).to.deep.equal(await Reference("label"));
      expect(received).to.include('"five"');
      expect(received).to.not.include('"four"');
      expect(received).to.not.include('"lone"');
    } finally {
      SetSampleThresholdForTests();
    }
  });

  it("counts a 26th value in other, though it is seen in 5 rows or more, and receives none past it", async () => {
    const { answer, received } = await Received(() =>
      CategoriesOf(r.db(CLIENT_DATABASE).table("tallies")("bucket")),
    );
    expect(answer.status).to.equal("ok");
    const categories =
      answer.status === "ok" ? answer.value : { values: [], other: 0 };
    expect(categories).to.deep.equal(await Reference("bucket"));
    expect(categories.values).to.have.length(CATEGORY_LIMIT);
    expect(categories.values.at(-1)).to.deep.equal({ value: "b24", rows: 7 });
    expect(categories.other).to.equal(7);
    expect(received).to.include('"b24"');
    expect(received).to.not.include('"b25"');
  });
});
