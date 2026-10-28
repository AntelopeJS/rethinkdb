import { defineConfig } from "@antelopejs/interface-core/config";

import {
  ACCOUNT_PASSWORD,
  CLIENT_DATABASE,
  SeedClientDatabase,
  SERVER,
  WRITER_USER,
} from "../test-external/fixture";

const EXTERNAL_MODE = "external";

const OWNED_CONFIG = {
  pool: {
    pool: true,
    cursor: false,
    silent: true,
    user: "admin",
    password: "",
    discovery: false,
    host: SERVER.host,
    port: SERVER.port,
  },
};

async function ExternalConfig() {
  await SeedClientDatabase();
  return {
    mode: EXTERNAL_MODE,
    url: `rethinkdb://${WRITER_USER}:${ACCOUNT_PASSWORD}@${SERVER.host}:${SERVER.port}/${CLIENT_DATABASE}`,
    catalog: { enabled: true },
  };
}

export default defineConfig({
  name: "rethinkdb-test",
  cacheFolder: ".antelope/cache",
  modules: {
    local: {
      source: { type: "local", path: "." },
    },
  },
  test: {
    folder: "dist/test",
    async setup() {
      const config =
        process.env.RETHINK_TEST_MODE === EXTERNAL_MODE
          ? await ExternalConfig()
          : OWNED_CONFIG;
      return { modules: { local: { config } } };
    },
  },
});
