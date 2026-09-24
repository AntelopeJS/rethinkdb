import { antelopeKnipConfig } from "@antelopejs/tooling-configs/knip";

export default antelopeKnipConfig({
  ignoreDependencies: [
    // The database conformance suites ship compiled inside
    // @antelopejs/interface-database and `require("chai")` out of this module's
    // own node_modules, so `ajs module test` needs both here even though no
    // source file imports them.
    "chai",
    "@types/chai",
    // Mocha's globals, supplied to those same suites.
    "@types/mocha",
  ],
});
