import type { VerifyConfig } from "@antelopejs/tooling-configs/verify";

import { atomicOutcomes } from "./journeys-atomic.ts";
import { catalogDescribe, catalogRefused, rawClient } from "./journeys-catalog.ts";
import { externalReads, externalRefusals, externalRegistration, externalWrites } from "./journeys-external.ts";
import { configRefused, connectionModes } from "./journeys-module.ts";
import { instances, storageLayout, uniqueRefused } from "./journeys-owned.ts";
import { readSelections, readStreams } from "./journeys-reads.ts";
import { poolConfig } from "./session.ts";
import { insertConflicts, insertValues, unstorableValues, updateReplaceDelete } from "./journeys-writes.ts";

const config: VerifyConfig = {
  doors: {
    data: {
      globs: [
        "src/implementations/database/schema.ts",
        "src/implementations/database/initialize.ts",
        "src/implementations/database/selection.ts",
        "src/implementations/database/atomic.ts",
        "src/implementations/database/external-writes.ts",
      ],
      funnels: ["src/implementations/database/selection.ts", "src/implementations/database/atomic.ts", "src/implementations/database/external-writes.ts"],
      containments: ["schemas/instances"],
      why: "these modules decide which database, table and instance a row is written to and read from: a change that stamps the wrong instance or writes outside the declared fields leaves rows an upgrade cannot find or a client's database holds wrong",
    },
    format: {
      globs: ["src/implementations/database/indexes.ts", "src/implementations/database/utils.ts"],
      funnels: [],
      containments: ["schemas/storage-layout"],
      why: "the names of the tenant_id and <name>__i indexes and the instance registry table are the layout every stored table already has: an upgrade that renames them stops finding what the last release wrote",
    },
    contract: {
      globs: ["package.json", "src/config.ts"],
      funnels: [],
      containments: [],
      why: "the config keys (`pool`, `connection`, `url`, `mode`, `statementTimeoutMs`, `catalog`), `antelopeJs.defaultConfig` and the implemented interfaces",
    },
    outbound: null,
    exposure: null,
    publish: {
      globs: ["package.json", ".release-it.json", "changelogen.config.json", ".github/workflows/release.yml"],
      funnels: [],
      containments: [],
      why: "the package name and release workflow claim @antelopejs/rethinkdb on npm",
    },
  },
  userFacing: ["src/*.ts", "src/utils/**", "src/implementations/**"],
  services: {
    rethinkdb: {
      image: "rethinkdb:2.4",
      port: 28015,
      ready: [
        "bash",
        "-c",
        'exec 3<>/dev/tcp/127.0.0.1/28015 && printf "\\xc3\\xbd\\xc2\\x34" >&3 && IFS= read -r -t 5 -d "" -u 3 reply; case "$reply" in *\\"success\\":true*) exit 0;; *) exit 1;; esac',
      ],
    },
  },
  moduleConfig(services) {
    const found = services.find((service) => service.name === "rethinkdb");
    return poolConfig({ name: "rethinkdb", container: found?.container ?? "", host: found?.host ?? "127.0.0.1", port: found?.port ?? 28015 });
  },
  journeys: {
    "connection-modes": connectionModes,
    "config-refused": configRefused,
    "storage-layout": storageLayout,
    "unique-refused": uniqueRefused,
    instances,
    "insert-values": insertValues,
    "unstorable-values": unstorableValues,
    "insert-conflicts": insertConflicts,
    "update-replace-delete": updateReplaceDelete,
    "atomic-outcomes": atomicOutcomes,
    "read-selections": readSelections,
    "read-streams": readStreams,
    "external-reads": externalReads,
    "external-registration": externalRegistration,
    "external-writes": externalWrites,
    "external-refusals": externalRefusals,
    "catalog-describe": catalogDescribe,
    "catalog-refused": catalogRefused,
    "raw-client": rawClient,
  },
};

export default config;
