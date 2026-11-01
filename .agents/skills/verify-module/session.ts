import type { App, Check, JourneyContext, ServiceEndpoint } from "@antelopejs/tooling-configs/verify";

import { APP_SOURCE } from "./app-source.ts";
import { canonical, isRecord, parseJson, pick, text, type Json } from "./json.ts";

export { pick, type Json } from "./json.ts";
export type ModuleConfig = NonNullable<NonNullable<Parameters<JourneyContext["fixture"]>[0]>["moduleConfig"]>;

/** The sorted keys of a JSON object, or an empty list. */
export function keysOf(value: Json | undefined): string[] {
  return isRecord(value) ? Object.keys(value).sort() : [];
}

/** A check that two values are the same JSON once their keys are in order; an absent value equals only another absent one. */
export function same(name: string, actual: Json | undefined, expected: Json | undefined): Check {
  const got = actual === undefined ? "<absent>" : JSON.stringify(canonical(actual));
  const want = expected === undefined ? "<absent>" : JSON.stringify(canonical(expected));
  return { name, pass: got === want, detail: `expected ${want}, got ${got}` };
}

/** The RethinkDB service of the run. */
export function server(context: JourneyContext): ServiceEndpoint {
  return context.service("rethinkdb");
}

/** The pool config pointing at the run's RethinkDB container. */
export function poolConfig(endpoint: ServiceEndpoint): ModuleConfig {
  return { pool: { host: endpoint.host, port: endpoint.port, user: "admin", password: "", pool: true, cursor: false, silent: true, discovery: false } };
}

/** A path made of `parts`, joined the way the harness writes them. */
export function path(...parts: string[]): string {
  return parts.join("/");
}

async function freePort(context: JourneyContext): Promise<number> {
  const picked = await context.command("pick a free port", "node", ["-e", "const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); });"]);
  return Number(picked.stdout.trim());
}

/** The text of a file, read with `cat` so the read is part of the evidence. */
export async function readText(context: JourneyContext, name: string, file: string): Promise<string> {
  const read = await context.command(name, "cat", [file]);
  return read.stdout;
}

/** What the project printed so far, standard output and error. */
export async function logs(session: Session): Promise<string> {
  const out = await readText(session.context, "read the project's output", path(session.app.folder, "stdout.txt"));
  const err = await readText(session.context, "read the project's errors", path(session.app.folder, "stderr.txt"));
  return `${out}\n${err}`;
}

/** What a scenario body answered: the value it returned or the error it threw. */
export interface Answer {
  folder: string;
  ok: boolean;
  value: Json | undefined;
  error: { name: string; message: string; fields: Json | undefined; index: Json | undefined } | null;
}

export interface Session {
  context: JourneyContext;
  app: App;
  base: string;
  /** Runs a scenario body inside the consumer module, with `db`, `common`, `rethink` and `waitFor` in scope. */
  run(name: string, body: string): Promise<Answer>;
}

function addConsumer(context: JourneyContext, project: string, moduleConfig: ModuleConfig, disabledExports: string[]): void {
  const modules = {
    rethinkdb: { source: { type: "local", path: context.repo }, config: moduleConfig, disabledExports },
    "verify-driver": { source: { type: "local", path: "./driver" } },
    "verify-app": { source: { type: "local", path: "./app" } },
  };
  context.edit("add the consumer module", path(project, "antelope.config.ts"), `export default ${JSON.stringify({ name: "verify-rethinkdb", modules }, null, 2)};\n`);
  context.edit("consumer package.json", path(project, "app", "package.json"), `${JSON.stringify({ name: "verify-app", version: "1.0.0", main: "index.js", antelopeJs: {} }, null, 2)}\n`);
  context.edit("consumer source", path(project, "app", "index.js"), APP_SOURCE);
}

/** Starts `ajs project dev` with the module configured as `moduleConfig` and a consumer module that runs scenario bodies. */
export async function open(context: JourneyContext, moduleConfig: ModuleConfig, disabledExports: string[] = []): Promise<Session> {
  const project = context.fixture({ moduleConfig });
  addConsumer(context, project, moduleConfig, disabledExports);
  const link = await context.command("link the repository's packages", "ln", ["-s", path(context.repo, "node_modules"), path(project, "app", "node_modules")]);
  context.expect(link.folder, [{ name: "the consumer resolves the repository's packages", pass: link.exitCode === 0, detail: link.stderr }], { critical: true });
  const port = await freePort(context);
  const app = await context.dev("ajs project dev", project, { env: { VERIFY_APP_PORT: String(port) } });
  const base = `http://127.0.0.1:${port}/`;
  return {
    context,
    app,
    base,
    async run(name, body) {
      const result = await context.http(name, base, { method: "POST", body });
      const answered = result.json;
      const error = pick(answered, "error");
      return {
        folder: result.folder,
        ok: pick(answered, "ok") === true,
        value: pick(answered, "value"),
        error: error === undefined ? null : { name: text(pick(error, "name")), message: text(pick(error, "message")), fields: pick(error, "fields"), index: pick(error, "index") },
      };
    },
  };
}

/** Runs a script with `rethinkdb-ts` against the run's container, as the database's owner would, and parses what it printed. */
export async function owner(context: JourneyContext, name: string, body: string): Promise<{ folder: string; value: Json | undefined; stderr: string; exitCode: number | null }> {
  const endpoint = server(context);
  const code = `const { r } = require("rethinkdb-ts");\n(async () => {\n const c = await r.connect({ host: process.argv[1], port: Number(process.argv[2]), user: "admin", password: "" });\n try {\n${body}\n } finally { await c.close(); }\n})().then((v) => { console.log(JSON.stringify(v === undefined ? null : v)); }, (e) => { console.error(String(e && e.message || e)); process.exit(1); });`;
  const result = await context.command(name, "node", ["-e", code, endpoint.host, String(endpoint.port)], { cwd: context.repo });
  return { folder: result.folder, value: parseJson(result.stdout.trim().split("\n").pop() ?? ""), stderr: result.stderr, exitCode: result.exitCode };
}

/** A failing check when the scenario did not answer ok. */
export function answered(result: Answer): Check {
  return { name: "the scenario ran", pass: result.ok, detail: JSON.stringify(result.error) };
}

/** Compares what the consumer module saw with what docs say it must be. */
export function sees(label: string, result: Answer, expected: Json): Check {
  return same(label, result.value, expected);
}

const EMPTY_SERVER = `const keep = ["rethinkdb", "test"];
for (const name of await r.dbList().run(c)) if (!keep.includes(name)) await r.dbDrop(name).run(c);
for (const user of await r.db("rethinkdb").table("users").getField("id").run(c)) if (user !== "admin") await r.db("rethinkdb").table("users").get(user).delete().run(c);
return await r.dbList().run(c);`;

/** Drops every database and account a previous journey left, so each journey starts from the container's empty state; a server still starting is asked again. */
export async function begin(context: JourneyContext): Promise<void> {
  let cleared = await owner(context, "empty the server", EMPTY_SERVER);
  for (let attempt = 2; attempt <= 4 && cleared.exitCode !== 0; attempt += 1) {
    cleared = await owner(context, `empty the server, attempt ${attempt}`, EMPTY_SERVER);
  }
  context.expect(cleared.folder, [same("only the system databases remain", cleared.value, ["rethinkdb", "test"])], { critical: true });
}
