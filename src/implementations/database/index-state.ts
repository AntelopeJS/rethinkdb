import { TermType } from "rethinkdb-ts/lib/proto/enums";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";

import { executeTermJson } from "../../connection";
import { type IndexStatus, IsIndexStatus } from "./external-probe";
import { type IndexCreation, REBUILD_INDEX_SUFFIX } from "./indexes";
import { IsList, IsObject, IsText } from "./utils";

/**
 * How the index a table holds under a name compares with the index its
 * declaration builds: absent, built by the same function, built by another
 * function or `multi` flag, or stored in a form the comparison cannot read.
 */
type IndexState = "missing" | "current" | "stale" | "unreadable";

/** A physical index with the state of its stored index and of a `<name>__rebuild` index an earlier rebuild left. */
export interface IndexPlan {
  creation: IndexCreation;
  state: IndexState;
  rebuildState: IndexState;
}

interface FunctionInfo {
  source_code: string;
}

const TEXT_VARIABLE_OR_SPACE = /"(?:[^"\\]|\\.)*"|\b_?var\d+\b|\s+/g;
const STORED_FUNCTION =
  /^indexCreate\('[^']*',\s*function\s*\(([^)]*)\)\s*\{\s*return\s+([\s\S]*);\s*\}(?:,\s*\{[^}]*\})?\)$/;
const DESCRIBED_FUNCTION =
  /^function\s*\(captures = \[[^\]]*\]\)\s*\(args = \[([^\]]*)\]\)\s*([\s\S]*)$/;

/**
 * The parameters and body of a function as the server prints it, with each
 * variable renamed by order of first use and the whitespace outside text
 * removed, so two functions that differ only in variable numbers, and in the
 * line breaks longer variable names cause, compare equal.
 */
function canonicalFunction(
  printed: string,
  pattern: RegExp,
): string | undefined {
  const match = pattern.exec(printed);
  if (match === null) {
    return undefined;
  }
  const names = new Map<string, string>();
  return `${match[1]}=>${match[2]}`.replace(TEXT_VARIABLE_OR_SPACE, (token) => {
    if (token.startsWith('"')) {
      return token;
    }
    if (token.trim() === "") {
      return "";
    }
    const name = names.get(token) ?? `v${names.size}`;
    names.set(token, name);
    return name;
  });
}

/** Whether `value` is what `info` answers for a function: the source the server prints for it. */
function IsFunctionInfo(value: unknown): value is FunctionInfo {
  return IsObject(value) && "source_code" in value && IsText(value.source_code);
}

async function readStoredIndexes(
  table: TermJson,
): Promise<Map<string, IndexStatus>> {
  const statuses: unknown = await executeTermJson([
    TermType.INDEX_STATUS,
    [table],
  ]);
  const stored = IsList(statuses) ? statuses.filter(IsIndexStatus) : [];
  return new Map(stored.map((status) => [status.index, status]));
}

/** The canonical form of each creation's function, printed by the server that stores the indexes. */
async function describeFunctions(
  creations: IndexCreation[],
): Promise<Array<string | undefined>> {
  const descriptions: unknown = await executeTermJson([
    TermType.MAKE_ARRAY,
    creations.map((creation) => [TermType.INFO, [creation.fn]]),
  ]);
  const described = IsList(descriptions) ? descriptions : [];
  return described.map((description) =>
    IsFunctionInfo(description)
      ? canonicalFunction(description.source_code, DESCRIBED_FUNCTION)
      : undefined,
  );
}

function compareIndex(
  stored: IndexStatus | undefined,
  creation: IndexCreation,
  described: string | undefined,
): IndexState {
  if (stored === undefined) {
    return "missing";
  }
  if (stored.multi !== creation.multi) {
    return "stale";
  }
  const storedFunction = canonicalFunction(stored.query, STORED_FUNCTION);
  if (storedFunction === undefined || described === undefined) {
    return "unreadable";
  }
  return storedFunction === described ? "current" : "stale";
}

/**
 * Compares each index a table needs with the index it holds under that name,
 * by the function and `multi` flag the server reports for both.
 */
export async function planIndexes(
  table: TermJson,
  creations: IndexCreation[],
): Promise<IndexPlan[]> {
  const [stored, described] = await Promise.all([
    readStoredIndexes(table),
    describeFunctions(creations),
  ]);
  return creations.map((creation, position) => {
    const compare = (name: string) =>
      compareIndex(stored.get(name), creation, described[position]);
    return {
      creation,
      state: compare(creation.name),
      rebuildState: compare(`${creation.name}${REBUILD_INDEX_SUFFIX}`),
    };
  });
}
