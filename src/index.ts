import "reflect-metadata";
import { ImplementInterface } from "@ajs/core/beta";
import type { RConnectionOptions, RPoolConnectionOptions } from "rethinkdb-ts";
import { ConnectDirect, ConnectPool, Disconnect } from "./connection";

interface Options {
  connection?: RConnectionOptions;
  pool?: RPoolConnectionOptions;
}

export async function construct(options: Options) {
  if (options?.pool) {
    await ConnectPool(options.pool);
  } else if (options?.connection) {
    await ConnectDirect(options.connection);
  } else {
    throw new Error("Invalid RethinkDB options");
  }

  await ImplementInterface(
    await import("@ajs.local/rethinkdb/beta"),
    await import("./implementations/rethinkdb/beta"),
  );
  await ImplementInterface(
    await import("@ajs.local/database/beta/query"),
    await import("./implementations/database/beta/query"),
  );
  await ImplementInterface(
    await import("@ajs.local/database/beta/schema"),
    await import("./implementations/database/beta/schema"),
  );
}

export async function start() {}

export function stop() {}

export function destroy() {
  Disconnect();
}
