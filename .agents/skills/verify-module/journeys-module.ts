import { has, interrupted, type Journey } from "@antelopejs/tooling-configs/verify";

import { answered, begin, open, owner, path, poolConfig, server, same, sees, type Answer, type ModuleConfig, type Session } from "./session.ts";

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
