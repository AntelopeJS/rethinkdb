#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSpec } from "@antelopejs/tooling-configs/formal";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, "../../..");
/**
 * Exit code when a rule changed. Model-checks IndexRebuild.tla with TLC under the configurations in
 * `CHECKS`; exits 0 when TLC agrees and 2 when TLC could not run.
 */
const CHANGED = 1;

/**
 * The lines of the code that IndexRebuild.tla models, each with the text it
 * must still hold. A line that moved or changed means the model may no longer
 * describe the code: read the covered code again, update IndexRebuild.tla and
 * these lines together, then move the sync commit in SKILL.md.
 *
 * @type {ReadonlyArray<readonly [file: string, line: number, pattern: RegExp]>}
 */
const ANCHORS = [
  ["initialize.ts", 28, /ALREADY_EXISTS_PATTERN = \/already exists\//],
  ["initialize.ts", 31, /REBUILD_ATTEMPTS = 5;/],
  ["initialize.ts", 91, /rebuildState === "stale" \|\| rebuildState === "unreadable"/],
  ["initialize.ts", 92, /TermType\.INDEX_DROP, \[table, rebuild\]/],
  ["initialize.ts", 94, /await createIndex\(table, rebuild, creation\)/],
  ["initialize.ts", 95, /TermType\.INDEX_WAIT, \[table, rebuild\]/],
  ["initialize.ts", 97, /TermType\.INDEX_RENAME,/],
  ["initialize.ts", 98, /\[table, rebuild, creation\.name\]/],
  ["initialize.ts", 99, /\{ overwrite: true \}/],
  ["initialize.ts", 116, /remaining = REBUILD_ATTEMPTS - 1; ; remaining--/],
  ["initialize.ts", 118, /await swapInRebuild\(table, attempt\)/],
  ["initialize.ts", 121, /attempt\] = await planIndexes\(table, \[plan\.creation\]\)/],
  ["initialize.ts", 122, /attempt\.state === "current"/],
  ["initialize.ts", 125, /remaining === 0/],
  ["initialize.ts", 139, /case "stale":/],
  ["initialize.ts", 157, /of await planIndexes\(table, creations\)/],
  ["index-state.ts", 93, /function compareIndex\(/],
  ["index-state.ts", 129, /rebuildState: compare\(`\$\{creation\.name\}\$\{REBUILD_INDEX_SUFFIX\}`\)/],
];

/** Fails the check when a modelled line of the code moved or changed. */
function checkAnchors() {
  const attempts = /Attempts = (\d+)/.exec(readFileSync(path.join(DIR, "IndexRebuild.cfg"), "utf8"))?.[1];
  const coded = /REBUILD_ATTEMPTS = (\d+);/.exec(readFileSync(path.join(ROOT, "src/implementations/database/initialize.ts"), "utf8"))?.[1];
  if (attempts !== coded) {
    console.log(`CHANGED anchors: REBUILD_ATTEMPTS is ${coded}, IndexRebuild.cfg says Attempts = ${attempts}`);
    process.exit(CHANGED);
  }
  /** @type {Map<string, string[]>} */
  const sources = new Map();
  const moved = ANCHORS.flatMap(([file, line, pattern]) => {
    const lines =
      sources.get(file) ??
      readFileSync(path.join(ROOT, "src/implementations/database", file), "utf8").split("\n");
    sources.set(file, lines);
    const found = lines[line - 1] ?? "";
    return pattern.test(found) ? [] : [`${file}:${line} no longer matches ${pattern}: ${found.trim()}`];
  });
  if (moved.length > 0) {
    console.log(`CHANGED anchors: the code the model describes moved.\n${moved.join("\n")}`);
    process.exit(CHANGED);
  }
}

checkAnchors();

/**
 * Each configuration and the rules it expects to break, with the states in
 * TLC's shortest counterexample. The first three describe the code, the rest
 * break it on purpose.
 *
 * @type {ReadonlyArray<{ config: string, findings: Record<string, number> }>}
 */
const CHECKS = [
  { config: "IndexRebuild", findings: {} },
  { config: "fresh-index", findings: {} },
  { config: "attempts-bound-holds", findings: {} },
  {
    config: "attempts-bound-breaks",
    findings: { NoBootFailsWhileOthersProgress: 12 },
  },
  {
    config: "swap-by-drop",
    findings: { QueriesFindAnIndex: 8, BootsStoreTheDeclaredFunction: 10 },
  },
  { config: "swap-by-copy", findings: { NoRebuildLeftBehind: 9 } },
  { config: "keep-leftover", findings: { BootsStoreTheDeclaredFunction: 6 } },
  { config: "no-reread", findings: { NoBootFailsWhileOthersProgress: 6 } },
];

for (const { config, findings } of CHECKS) {
  await checkSpec({
    dir: DIR,
    spec: "IndexRebuild",
    config,
    findings,
  });
}
