import { expect } from "chai";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import type { ProbeAnswer } from "@antelopejs/interface-database-catalog";
import { type Connection, r } from "rethinkdb-ts";

import { probe } from "../probe";
import { AdminConnection, SERVER } from "../test-external/fixture";
import {
  ClosedPort,
  CountsQueries,
  DropsOnChunk,
  FailsChunk,
  SilentServer,
  StallsAfterSignIn,
  StartRelay,
} from "./probe-servers";

const TIMEOUT_MS = 1000;
const SETTLE_MS = 1000;
const STOP_AFTER_MS = 100;
const RUN = randomBytes(4).toString("hex");
const SHOP = `probe_shop_${RUN}`;
const EMPTY = `probe_empty_${RUN}`;
const WIDE = `probe_wide_${RUN}`;
const WIDE_TABLES = 40;
const PASSWORD = `probe-${RUN}`;
const READER = `probe_reader_${RUN}`;
const WRITER = `probe_writer_${RUN}`;
const BLIND = `probe_blind_${RUN}`;
const MAILED = `probe@reader_${RUN}`;
const ACCOUNTS = [READER, WRITER, BLIND, MAILED];
const PROBE_FILE = path.join(__dirname, "..", "probe.js");
const INTERNAL = 1_000_000;
const OP_FAILED = 4_100_000;
const PERMISSION_ERROR = 6_000_000;
const ABORTED = { outcome: "unreachable", message: "The probe was aborted." };

function UrlOf(
  user: string,
  options: { password?: string; database?: string; port?: number } = {},
): string {
  const password = options.password ?? (user === "admin" ? "" : PASSWORD);
  const database = options.database ?? SHOP;
  const port = options.port ?? SERVER.port;
  return `rethinkdb://${encodeURIComponent(user)}:${password}@${SERVER.host}:${port}/${database}`;
}

function Probe(url: string, signal = new AbortController().signal) {
  return probe({ url, timeoutMs: TIMEOUT_MS, signal });
}

async function AsAdmin<T>(work: (admin: Connection) => Promise<T>) {
  const admin = await AdminConnection();
  try {
    return await work(admin);
  } finally {
    await admin.close();
  }
}

async function SetUpShop(admin: Connection) {
  await r.dbCreate(SHOP).run(admin);
  await r.dbCreate(EMPTY).run(admin);
  await r.db(SHOP).tableCreate("orders").run(admin);
  await r.db(SHOP).tableCreate("notes").run(admin);
  await r.db(SHOP).table("orders").insert({ id: 1, total: 1 }).run(admin);
  for (const user of ACCOUNTS) {
    await r
      .db("rethinkdb")
      .table("users")
      .insert({ id: user, password: PASSWORD })
      .run(admin);
  }
  await r.db(SHOP).grant(READER, { read: true }).run(admin);
  await r.db(SHOP).grant(MAILED, { read: true }).run(admin);
  await r.db(SHOP).grant(WRITER, { read: true, write: true }).run(admin);
  await r.dbCreate(WIDE).run(admin);
  await Promise.all(
    Array.from({ length: WIDE_TABLES }, (_, index) =>
      r.db(WIDE).tableCreate(`t${index}`).run(admin),
    ),
  );
  await r.db(WIDE).wait().run(admin);
  await r.db(WIDE).grant(READER, { read: true }).run(admin);
  await r.db(WIDE).grant(WRITER, { read: true, write: true }).run(admin);
}

async function TearDownShop(admin: Connection) {
  await r.dbDrop(SHOP).run(admin);
  await r.dbDrop(EMPTY).run(admin);
  await r.dbDrop(WIDE).run(admin);
  await r
    .db("rethinkdb")
    .table("users")
    .getAll(...ACCOUNTS)
    .delete()
    .run(admin);
}

function SignedIn(answer: ProbeAnswer) {
  expect(answer.outcome).to.equal("signed-in");
  return answer;
}

function AccountCases() {
  it("answers read and no write to an account that may only read, with its first query's time", async () => {
    const answer = await Probe(UrlOf(READER));
    expect(answer).to.deep.include({
      outcome: "signed-in",
      user: READER,
      canRead: true,
      canWrite: false,
    });
    expect(answer).to.not.have.property("unreadable");
    expect(answer).to.have.property("latencyMs").that.is.greaterThan(0);
  });

  it("answers read and write to an account that may write", async () => {
    expect(await Probe(UrlOf(WRITER))).to.deep.include({
      user: WRITER,
      canRead: true,
      canWrite: true,
    });
  });

  it("answers no access to an account that may use no table", async () => {
    const answer = SignedIn(await Probe(UrlOf(BLIND)));
    expect(answer).to.deep.include({ canRead: false, canWrite: false });
    expect(answer).to.not.have.property("unreadable");
  });

  it("answers read to an account whose name holds an @, under its decoded name", async () => {
    expect(await Probe(UrlOf(MAILED))).to.deep.include({
      outcome: "signed-in",
      user: MAILED,
      canRead: true,
      canWrite: false,
    });
  });

  it("deletes no row of the tables an account that may write is asked about", async () => {
    await Probe(UrlOf(WRITER));
    const rows = await AsAdmin((admin) =>
      r.db(SHOP).table("orders").count().run(admin),
    );
    expect(rows).to.equal(1);
  });
}

function DatabaseCases() {
  it("answers a database with no table as read and not written, under admin when the URL names no user", async () => {
    const url = `rethinkdb://${SERVER.host}:${SERVER.port}/${EMPTY}`;
    expect(await Probe(url)).to.deep.include({
      outcome: "signed-in",
      user: "admin",
      canRead: true,
      canWrite: false,
    });
  });

  it("answers a database the server lacks as signed in, with no access", async () => {
    expect(
      await Probe(UrlOf("admin", { database: `probe_missing_${RUN}` })),
    ).to.deep.include({
      outcome: "signed-in",
      user: "admin",
      canRead: false,
      canWrite: false,
      unreadable: "no-database",
    });
  });

  it("answers a path no database can be named as signed in, with no access", async () => {
    for (const database of ["a.b", "shop/extra"]) {
      expect(
        await Probe(UrlOf("admin", { database })),
        database,
      ).to.deep.include({
        outcome: "signed-in",
        canRead: false,
        canWrite: false,
        unreadable: "no-database",
      });
    }
  });

  it("answers a URL that names no database as signed in, with no access", async () => {
    const address = `rethinkdb://admin:@${SERVER.host}:${SERVER.port}`;
    for (const url of [address, `${address}/`]) {
      expect(await Probe(url), url).to.deep.include({
        outcome: "signed-in",
        user: "admin",
        canRead: false,
        canWrite: false,
        unreadable: "no-database-named",
      });
    }
  });
}

function RefusedCases() {
  it("answers a wrong password as refused credentials", async () => {
    const wrong = `wrong-${RUN}`;
    const answer = await Probe(UrlOf(READER, { password: wrong }));
    expect(answer).to.deep.include({
      outcome: "refused",
      refusal: "credentials",
    });
  });

  it("answers a port nothing listens on as unreachable, within the timeout", async () => {
    const started = performance.now();
    const answer = await Probe(UrlOf(READER, { port: await ClosedPort() }));
    expect(performance.now() - started).to.be.lessThan(TIMEOUT_MS);
    expect(answer.outcome).to.equal("unreachable");
  });

  it("answers a server that never speaks as unreachable, once the connect times out", async () => {
    const silent = await SilentServer();
    try {
      const started = performance.now();
      const answer = await Probe(UrlOf(READER, { port: silent.port }));
      expect(performance.now() - started).to.be.lessThan(TIMEOUT_MS * 2);
      expect(answer.outcome).to.equal("unreachable");
      expect(await silent.openAfter(SETTLE_MS)).to.equal(0);
    } finally {
      await silent.close();
    }
  });

  it("loads and answers outside the AntelopeJS runtime", async () => {
    const port = await ClosedPort();
    const script = `require(${JSON.stringify(PROBE_FILE)}).probe({ url: "rethinkdb://127.0.0.1:${port}/shop", timeoutMs: ${TIMEOUT_MS}, signal: new AbortController().signal }).then((answer) => process.stdout.write(answer.outcome))`;
    const { stdout } = await promisify(execFile)(process.execPath, [
      "-e",
      script,
    ]);
    expect(stdout).to.equal("unreachable");
  });
}

function BoundedWorkCases() {
  const FIRST_QUERY_AND_LISTING = 2;
  const BATCH = 32;

  async function QueriesOf(user: string) {
    const counter = CountsQueries();
    const relay = await StartRelay(SERVER.port, counter.route);
    try {
      const answer = await Probe(
        UrlOf(user, { database: WIDE, port: relay.port }),
      );
      return { answer, queries: counter.queries() };
    } finally {
      await relay.close();
    }
  }

  it("stops checking tables once one has proven read and one has proven write", async () => {
    const { answer, queries } = await QueriesOf(WRITER);
    expect(answer).to.deep.include({ canRead: true, canWrite: true });
    expect(queries).to.equal(FIRST_QUERY_AND_LISTING + 2 * BATCH);
  });

  it("checks only write on the tables after the one that proved read", async () => {
    const { answer, queries } = await QueriesOf(READER);
    expect(answer).to.deep.include({ canRead: true, canWrite: false });
    expect(queries).to.equal(
      FIRST_QUERY_AND_LISTING + 2 * BATCH + (WIDE_TABLES - BATCH),
    );
  });
}

function ServerFailureCases() {
  it("answers cannot-list, signed in, when the server refuses or fails the listing of the tables", async () => {
    const LISTING = 2;
    const failures: [number, string][] = [
      [
        PERMISSION_ERROR,
        "User `reader` does not have the required `read` permissions.",
      ],
      [OP_FAILED, `Database \`${SHOP}\` is not available.`],
      [INTERNAL, "The server failed the listing."],
    ];
    for (const [errorType, message] of failures) {
      const relay = await StartRelay(
        SERVER.port,
        FailsChunk(LISTING, errorType, message),
      );
      try {
        const answer = await Probe(UrlOf(READER, { port: relay.port }));
        expect(answer, message).to.deep.include({
          outcome: "signed-in",
          user: READER,
          canRead: false,
          canWrite: false,
          unreadable: "cannot-list",
        });
        expect(answer, message)
          .to.have.property("latencyMs")
          .that.is.greaterThan(0);
      } finally {
        await relay.close();
      }
    }
  });

  it("answers unreachable when the server drops the connection on the listing of the tables", async () => {
    const LISTING = 2;
    const relay = await StartRelay(SERVER.port, DropsOnChunk(LISTING));
    try {
      const answer = await Probe(UrlOf(READER, { port: relay.port }));
      expect(answer.outcome).to.equal("unreachable");
    } finally {
      await relay.close();
    }
  });

  it("answers unreachable, not an account with no access, when the server drops the connection during the table checks", async () => {
    const FIRST_TABLE_CHECK = 3;
    const relay = await StartRelay(
      SERVER.port,
      DropsOnChunk(FIRST_TABLE_CHECK),
    );
    try {
      const answer = await Probe(UrlOf("admin", { port: relay.port }));
      expect(answer.outcome).to.equal("unreachable");
    } finally {
      await relay.close();
    }
  });
}

function ClosingCases() {
  it("closes its connection once it has answered", async () => {
    const relay = await StartRelay(SERVER.port);
    try {
      const answer = await Probe(UrlOf(WRITER, { port: relay.port }));
      expect(answer.outcome).to.equal("signed-in");
      expect(await relay.openAfter(SETTLE_MS)).to.equal(0);
    } finally {
      await relay.close();
    }
  });

  it("closes its connection and answers unreachable once the server stops answering after the sign-in", async () => {
    const relay = await StartRelay(SERVER.port, StallsAfterSignIn);
    try {
      const started = performance.now();
      const answer = await Probe(UrlOf(WRITER, { port: relay.port }));
      expect(performance.now() - started).to.be.lessThan(TIMEOUT_MS * 2);
      expect(answer.outcome).to.equal("unreachable");
      expect(await relay.openAfter(SETTLE_MS)).to.equal(0);
    } finally {
      await relay.close();
    }
  });

  it("closes its connection at once when the signal aborts, whatever the server does", async () => {
    const relay = await StartRelay(SERVER.port, StallsAfterSignIn);
    const stop = new AbortController();
    try {
      setTimeout(() => stop.abort(), STOP_AFTER_MS);
      const started = performance.now();
      const answer = await Probe(
        UrlOf(WRITER, { port: relay.port }),
        stop.signal,
      );
      expect(performance.now() - started).to.be.lessThan(TIMEOUT_MS / 2);
      expect(answer).to.deep.equal(ABORTED);
      expect(await relay.openAfter(SETTLE_MS)).to.equal(0);
    } finally {
      await relay.close();
    }
  });

  it("closes its connection at once when the signal aborts during the connect", async () => {
    const silent = await SilentServer();
    const stop = new AbortController();
    try {
      setTimeout(() => stop.abort(), STOP_AFTER_MS);
      const started = performance.now();
      const answer = await Probe(
        UrlOf(READER, { port: silent.port }),
        stop.signal,
      );
      expect(performance.now() - started).to.be.lessThan(TIMEOUT_MS / 2);
      expect(answer).to.deep.equal(ABORTED);
      expect(await silent.openAfter(SETTLE_MS)).to.equal(0);
    } finally {
      await silent.close();
    }
  });

  it("opens no connection when the signal has already aborted", async () => {
    const silent = await SilentServer();
    try {
      const answer = await Probe(
        UrlOf(READER, { port: silent.port }),
        AbortSignal.abort(),
      );
      expect(answer).to.deep.equal(ABORTED);
      await new Promise((resolve) => setTimeout(resolve, STOP_AFTER_MS));
      expect(silent.accepted()).to.equal(0);
    } finally {
      await silent.close();
    }
  });
}

describe("the connection probe", function () {
  this.timeout(TIMEOUT_MS * 10);

  before(() => AsAdmin(SetUpShop));
  after(() => AsAdmin(TearDownShop));

  AccountCases();
  DatabaseCases();
  RefusedCases();
  BoundedWorkCases();
  ServerFailureCases();
  ClosingCases();
});
