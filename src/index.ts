import "reflect-metadata";
import { ImplementInterface } from "@antelopejs/interface-core";
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

  void ImplementInterface(
    await import("@antelopejs/interface-rethinkdb"),
    await import("./implementations/rethinkdb"),
  );
  void ImplementInterface(
    await import("@antelopejs/interface-database/query"),
    await import("./implementations/database/query"),
  );
  void ImplementInterface(
    await import("@antelopejs/interface-database/schema"),
    await import("./implementations/database/schema"),
  );
}

export async function start() {}

export function stop() {}

export function destroy() {
  Disconnect();
}
