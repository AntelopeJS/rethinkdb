import { expect } from "chai";
import { r } from "rethinkdb-ts";

import { GetOptions, type Options, SetOptions } from "../config";
import { AdminConnection, CLIENT_DATABASE } from "./fixture";

const OWNED_DATABASES = ["erp", "__instances__"];

describe("an external RethinkDB instance at startup", () => {
  it("creates no database and no registry table", async () => {
    const connection = await AdminConnection();
    try {
      const databases = await r.dbList().run(connection);
      const tables = await r.db(CLIENT_DATABASE).tableList().run(connection);
      expect(databases).to.not.include.members(OWNED_DATABASES);
      expect(tables).to.not.include("__instances__");
    } finally {
      await connection.close();
    }
  });
});

describe("external RethinkDB configuration", () => {
  let configured: Options;

  beforeEach(() => {
    configured = { ...GetOptions(), url: undefined, mode: "external" };
  });

  it("refuses to resolve without url, rather than falling back to a default", () => {
    expect(() => SetOptions(configured)).to.throw(
      'mode "external" needs a non-empty config.url',
    );
  });

  it("refuses a url without a database path", () => {
    expect(() =>
      SetOptions({ ...configured, url: "rethinkdb://u:p@127.0.0.1:28015" }),
    ).to.throw("the database as the path of config.url");
  });

  it("refuses pool.db when it disagrees with the url", () => {
    expect(() =>
      SetOptions({
        ...configured,
        url: "rethinkdb://u:p@127.0.0.1:28015/erp_test",
        pool: { db: "other" },
      }),
    ).to.throw("pool.db (other) disagrees");
  });
});
