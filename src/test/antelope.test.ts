import { defineConfig } from "@antelopejs/interface-core/config";

export default defineConfig({
  name: "rethinkdb-test",
  cacheFolder: ".antelope/cache",
  modules: {
    local: {
      source: { type: "local", path: "." },
      config: {
        pool: {
          pool: true,
          cursor: false,
          silent: true,
          user: "admin",
          password: "",
          discovery: false,
          host: "127.0.0.1",
          port: 28015,
        },
      },
    },
  },
  test: {
    folder: "dist/test",
  },
});
