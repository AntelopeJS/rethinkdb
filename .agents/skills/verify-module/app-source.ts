/** The consumer module every journey adds beside the driver: it runs a scenario body inside the project, with the AQL package and `rethinkdb-ts` in scope, and answers the JSON it returned. */
export const APP_SOURCE = String.raw`"use strict";
const http = require("node:http");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let server;

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]));
  return value;
}

function plain(value) {
  return ordered(JSON.parse(JSON.stringify(value === undefined ? null : value)));
}

async function answer(request) {
  let text = "";
  for await (const chunk of request) text += chunk;
  try {
    const scenario = new AsyncFunction("db", "common", "rethink", "rdb", "catalog", "load", "waitFor", text);
    const value = await scenario(
      require("@antelopejs/interface-database"),
      require("@antelopejs/interface-database/common"),
      require("rethinkdb-ts"),
      require("@antelopejs/interface-rethinkdb"),
      require("@antelopejs/interface-database-catalog"),
      require,
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    );
    return { ok: true, value: plain(value) };
  } catch (error) {
    return { ok: false, error: { name: (error && error.name) || "Error", message: String((error && error.message) || error), fields: error && error.fields, index: error && error.index } };
  }
}

exports.construct = function construct() {};
exports.start = async function start() {
  server = http.createServer((request, response) => {
    answer(request).then((result) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(result));
    });
  });
  await new Promise((resolve) => server.listen(Number(process.env.VERIFY_APP_PORT), "127.0.0.1", resolve));
};
exports.stop = function stop() {
  if (server) server.close();
};
exports.destroy = function destroy() {};
`;
