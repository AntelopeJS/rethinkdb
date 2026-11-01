import { has, interrupted, refused, type Journey } from "@antelopejs/tooling-configs/verify";

import { externalConfig, NO_RETHINKDB, part, PREAMBLE, seedClient, stopped } from "./external-seed.ts";
import { parseJson, tuple } from "./json.ts";
import { answered, begin, open, owner, path, pick, poolConfig, server, same, sees, type Answer, type ModuleConfig, type Session } from "./session.ts";

const ROUND_TRIP = `const schema = new db.Schema("verify-config", { notes: { fields: { title: "string" }, indexes: {} } });
await schema.createInstance("a");
const notes = schema.instance("a").table("notes");
await notes.insert({ _id: "n1", title: "stored" });
return (await notes.get("n1")).title;`;

async function roundTrip(session: Session, label: string): Promise<Answer> {
  const result = await session.run(label, ROUND_TRIP);
  session.context.expect(result.folder, [answered(result), sees("the document written through the module reads back", result, "stored")]);
  return result;
}

async function stop(session: Session): Promise<void> {
  const stopped = await session.context.stop("SIGINT", session.app);
  session.context.expect(stopped.folder, [interrupted(stopped)]);
}

/** One module instance configured three ways, each of which must reach the run's server. */
export const connectionModes: Journey = {
  title: "the module connects through pool, through connection, or through url, and pool wins when both pool and connection are set",
  entryPoint: "`pool`, `connection` and `url` in the module's config in antelope.config.ts",
  async run(context) {
    const manifest = await context.command("read the module's package.json, where the default configuration `ajs project modules add` writes lives", "cat", [path(context.repo, "package.json")]);
    const defaults = pick(parseJson(manifest.stdout), "antelopeJs", "defaultConfig", "pool");
    context.expect(manifest.folder, [
      same("the default configuration is a connection pool to 127.0.0.1:28015 as admin", tuple(pick(defaults, "pool"), pick(defaults, "host"), pick(defaults, "port"), pick(defaults, "user")), [true, "127.0.0.1", "28015", "admin"]),
    ]);
    const endpoint = server(context);
    const direct: ModuleConfig = { host: endpoint.host, port: endpoint.port, user: "admin", password: "" };
    const dead: ModuleConfig = { host: "127.0.0.1", port: 1, user: "admin", password: "" };
    const modes: [string, ModuleConfig][] = [
      ["connection only", { connection: direct }],
      ["url only", { url: `rethinkdb://admin:@${endpoint.host}:${endpoint.port}` }],
      ["pool and a dead connection", { ...poolConfig(endpoint), connection: dead }],
    ];
    for (const [label, config] of modes) {
      await begin(context);
      const session = await open(context, config);
      await roundTrip(session, `round trip with ${label}`);
      const native = await owner(context, `read back with ${label}`, `return await r.db("verify-config").table("notes").get("n1").getField("title").run(c);`);
      context.expect(native.folder, [same(`rethinkdb-ts reads the stored title (${label})`, native.value, "stored")]);
      await stop(session);
    }
  },
};

const REFUSALS: [string, ModuleConfig, RegExp][] = [
  ["no url, pool or connection", {}, /Invalid RethinkDB options: set url, pool or connection/],
  ["an external instance without a url", { mode: "external", pool: { host: "127.0.0.1", port: 1 } }, /mode "external" needs a non-empty config\.url/],
  ["an external url without a database", { mode: "external", url: "rethinkdb://admin:@127.0.0.1:1" }, /mode "external" needs the database as the path of config\.url/],
  ["a pool.db that disagrees with the url", { mode: "external", url: "rethinkdb://admin:@127.0.0.1:1/erp", pool: { db: "other" } }, /pool\.db \(other\) disagrees with the database of config\.url \(erp\)/],
  ["an unknown mode", { mode: "shared", pool: { host: "127.0.0.1", port: 1 } }, /mode must be one of owned, external, received shared/],
  ["a statementTimeoutMs of zero", { mode: "external", url: "rethinkdb://admin:@127.0.0.1:1/erp", statementTimeoutMs: 0 }, /statementTimeoutMs must be a positive safe integer, received 0/],
  ["a fractional statementTimeoutMs", { mode: "external", url: "rethinkdb://admin:@127.0.0.1:1/erp", statementTimeoutMs: 1.5 }, /statementTimeoutMs must be a positive safe integer, received 1\.5/],
  ["a negative statementTimeoutMs", { mode: "external", url: "rethinkdb://admin:@127.0.0.1:1/erp", statementTimeoutMs: -5 }, /statementTimeoutMs must be a positive safe integer, received -5/],
  ["a url that is not rethinkdb://", { url: "http://127.0.0.1:1/erp" }, /url must start with rethinkdb:\/\/, received http:\/\//],
];

export const configRefused: Journey = {
  title: "the module refuses to start on a config README.md and docs/external-mode.md exclude, and says why",
  entryPoint: "`ajs project dev` with an unusable `config` in antelope.config.ts",
  async run(context) {
    const cli = path(context.repo, "node_modules/@antelopejs/core/dist/core/cli/index.js");
    for (const [label, config, message] of REFUSALS) {
      const project = context.fixture({ moduleConfig: config });
      const started = await context.command(`ajs project dev with ${label}`, "node", [cli, "project", "dev"], { cwd: project, timeoutMs: 60_000 });
      context.expect(started.folder, [
        { name: `the project did not come up with ${label}`, pass: started.exitCode !== 0, detail: `exit ${String(started.exitCode)}` },
        has(`the refusal says why (${label})`, started.stderr, message),
      ]);
    }
  },
};

/**
 * The pack's `module-dev` journey, kept under its id so `guardedAll` can guard it: the pack runs its own copy unguarded, so a RethinkDB
 * outage right after `ajs project dev` starts would fail it as if the module were broken (tooling-configs#132).
 */
export const moduleDev: Journey = {
  title: "the module loads from its local source against its backing services and stops on Ctrl+C",
  entryPoint: "`ajs project dev` on a project that installs the module as `local`",
  async run(context) {
    const project = context.fixture();
    const app = await context.dev("ajs project dev", project);
    const surface = await context.http("implemented interfaces", `http://127.0.0.1:${app.port}/surface`, { method: "POST", body: "{}" });
    context.expect(surface.folder, [{ name: "the consumer loaded every implemented interface", pass: pick(surface.json, "ok") === true, detail: surface.body.slice(0, 300) }]);
    const stopped = await context.stop("SIGINT", app);
    context.expect(stopped.folder, [interrupted(stopped)]);
    const after = await context.http("port after stop", `http://127.0.0.1:${app.port}/health`);
    context.expect(after.folder, [refused(after)]);
  },
};

export const externalOptions: Journey = {
  title: "an external instance merges pool options under the url, so the url's server wins, and closes a read that outlasts statementTimeoutMs with a timeout",
  entryPoint: "`pool` and `statementTimeoutMs` beside `url` in the config of an external instance, read with a reader account",
  async run(context) {
    await begin(context);
    await seedClient(context);
    const orders = await owner(context, "add 40000 orders to the client database", `await r.db("erp").table("orders").insert(Array.from({ length: 40000 }, (_, n) => ({ id: "o" + n, customer_id: "c" + n, total: n }))).run(c); return "added";`);
    context.expect(orders.folder, [same("the orders are stored", orders.exitCode, 0)], { critical: true });
    const base = externalConfig(context, "erp_reader");
    const scan = `${PREAMBLE}
await attempt("count", () => t("customers").count());
await attempt("scan", async () => (await t("orders").filter((row) => row.key("total").eq(-1))).length);
return out;`;
    const merged = await open(context, { ...base, pool: { host: "127.0.0.1", port: 1, pool: true, cursor: false, silent: true, discovery: false } }, NO_RETHINKDB);
    const unlimited = await merged.run("read with a pool pointing at a dead server and no time limit", scan);
    context.expect(unlimited.folder, [answered(unlimited)], { critical: true });
    context.expect(unlimited.folder, [
      sees("the url's server wins over the pool's host and port", part(unlimited, "count"), 4),
      sees("without a limit the scan reads every order and matches none", part(unlimited, "scan"), 0),
    ]);
    await stopped(merged);
    const limited = await open(context, { ...base, statementTimeoutMs: 1 }, NO_RETHINKDB);
    const timed = await limited.run("read with statementTimeoutMs 1", scan);
    context.expect(timed.folder, [answered(timed)], { critical: true });
    context.expect(timed.folder, [has("a read that outlasts statementTimeoutMs rejects with a timeout", JSON.stringify(pick(timed.value, "scan")), /"error":".*time/i)]);
    await stopped(limited);
  },
};
