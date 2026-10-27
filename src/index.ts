import "reflect-metadata";
import { ImplementInterface } from "@antelopejs/interface-core";

import { IsExternal, type Options, SetOptions } from "./config";
import {
  ConnectDirect,
  ConnectPool,
  Disconnect,
  SetDirectOptions,
} from "./connection";

export type { CatalogOptions, Mode, Options } from "./config";

export async function construct(options?: Options) {
  const resolved = SetOptions(options);
  if (resolved.pool) {
    await ConnectPool(resolved.pool);
    SetDirectOptions(resolved.pool);
  } else if (resolved.connection) {
    await ConnectDirect(resolved.connection);
    SetDirectOptions(resolved.connection);
  }

  if (!IsExternal()) {
    void ImplementInterface(
      await import("@antelopejs/interface-rethinkdb"),
      await import("./implementations/rethinkdb"),
    );
  }
  void ImplementInterface(
    await import("@antelopejs/interface-database/query"),
    await import("./implementations/database/query"),
  );
  void ImplementInterface(
    await import("@antelopejs/interface-database/schema"),
    await import("./implementations/database/schema"),
  );
  void ImplementInterface(
    await import("@antelopejs/interface-database-catalog"),
    await import("./implementations/catalog"),
  );
}

export async function start() {}

export function stop() {}

export function destroy() {
  Disconnect();
}
