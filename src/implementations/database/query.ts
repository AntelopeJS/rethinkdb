import assert from "node:assert";
import type { Cursor } from "rethinkdb-ts/lib/response/cursor";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import { ValidateAtomicMutationTable } from "@antelopejs/interface-database/atomic";
import { IsQueryStage } from "@antelopejs/interface-database/common";
import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";

import { Logger } from "../../utils/logger";
import {
  OpenBoundedCursor,
  QueryTimeoutError,
  SendQuery,
} from "../../connection";
import { SelectionQuery } from "./selection";
import { GetOptions, IsExternal } from "../../config";
import {
  ExternalAtomicRefusal,
  ExternalInstanceRefusal,
} from "./external-selection";
import { runAtomicMutation } from "./atomic";
import {
  DecodingContext,
  IsObject,
  type QueryStage,
  StageNamed,
} from "./utils";
import {
  CreateInstance,
  DestroyInstance,
  ListInstances,
  WaitForSchemaReady,
} from "./schema";

type SchemaStageHandler = (
  schemaId: string,
  stages: QueryStage[],
) => Promise<any>;

/**
 * The lifecycle stages on an external instance, whose tables have no instances: creating or
 * destroying one is refused rather than recorded nowhere, and the list of them is empty.
 */
const EXTERNAL_LIFECYCLE_HANDLERS = new Map<string, SchemaStageHandler>([
  [
    "createInstance",
    (_schemaId, stages) =>
      Promise.reject(ExternalInstanceRefusal(stages[1].stage)),
  ],
  [
    "destroyInstance",
    (_schemaId, stages) =>
      Promise.reject(ExternalInstanceRefusal(stages[1].stage)),
  ],
  ["listInstances", () => Promise.resolve([])],
]);

const SCHEMA_STAGE_HANDLERS = new Map<string, SchemaStageHandler>([
  [
    "instance",
    async (schemaId, stages): Promise<any> => {
      await WaitForSchemaReady(schemaId);
      if (stages.some((stage) => stage.stage === "atomicMutation")) {
        if (IsExternal()) {
          const table = stages[2];
          throw ExternalAtomicRefusal(
            IsQueryStage(table, "table") ? table.options.id : undefined,
          );
        }
        return runAtomicStages(stages);
      }
      const context = new DecodingContext();
      return SelectionQuery.decode(stages, context).run();
    },
  ],
  [
    "createInstance",
    (schemaId, stages) =>
      CreateInstance(
        schemaId,
        StageNamed(stages[1], "createInstance").options?.id,
      ),
  ],
  [
    "destroyInstance",
    (schemaId, stages) =>
      DestroyInstance(
        schemaId,
        StageNamed(stages[1], "destroyInstance").options?.id,
      ),
  ],
  ["listInstances", (schemaId) => ListInstances(schemaId)],
]);

export async function RunQuery(stages: QueryStage[]): Promise<any> {
  assert(stages[0]?.stage === "schema", "Expected schema stage");
  const schemaId = stages[0].options?.id;
  assert(schemaId, "Unknown schema");

  const next = stages[1]?.stage;
  const external =
    IsExternal() && next ? EXTERNAL_LIFECYCLE_HANDLERS.get(next) : undefined;
  const handler =
    external ?? (next ? SCHEMA_STAGE_HANDLERS.get(next) : undefined);
  assert(handler, `Unknown schema stage '${next}'`);
  return handler(schemaId, stages);
}

function runAtomicStages(stages: QueryStage[]) {
  const terminal = stages.at(-1);
  assert(
    terminal?.stage === "atomicMutation",
    "Atomic mutation must be terminal",
  );
  assert(
    terminal.options === undefined && terminal.args?.length === 2,
    "Atomic mutation requires one key and request without options",
  );
  const prefix = stages.slice(0, -1);
  ValidateAtomicMutationTable(prefix);
  const query = SelectionQuery.decode(prefix, new DecodingContext());
  assert(query.instanceId !== CROSS_INSTANCE, "Atomic mutation must be scoped");
  return runAtomicMutation(
    query.getTableTerm(),
    query.instanceId ?? "",
    terminal.args[0],
    terminal.args[1],
  );
}

interface OpenCursor {
  cursor: Cursor;
  iterator: AsyncIterableIterator<unknown>;
  isChangeStream: boolean;
  arm?: () => void;
  disarm?: () => void;
  release?: () => void;
  expired?: () => boolean;
  timeoutMs?: number;
}

/** The cursor of a read: on an external instance with a time limit, on a connection of its own. */
async function Opened(
  query: SelectionQuery,
  term: TermJson,
): Promise<Omit<OpenCursor, "iterator" | "isChangeStream">> {
  const timeoutMs = query.external
    ? GetOptions().statementTimeoutMs
    : undefined;
  if (timeoutMs === undefined) {
    const cursor = await SendQuery(term);
    assert(cursor, "Query returned no cursor.");
    return { cursor };
  }
  return { ...(await OpenBoundedCursor(term, timeoutMs)), timeoutMs };
}

function Release(reqId: number) {
  openCursors.get(reqId)?.release?.();
  openCursors.delete(reqId);
}

const openCursors = new Map<number, OpenCursor>();

export async function ReadCursor(
  reqId: number,
  stages: QueryStage[],
): Promise<IteratorResult<unknown, void>> {
  if (!openCursors.has(reqId)) {
    assert(stages[0]?.stage === "schema", "Expected schema stage");
    const schemaId = stages[0].options?.id;
    assert(schemaId, "Unknown schema");
    await WaitForSchemaReady(schemaId);
    const context = new DecodingContext();
    const query = SelectionQuery.decode(stages, context);
    const term = query.buildTerm();
    Logger.Debug("Opening cursor #", reqId);
    const opened = await Opened(query, term);
    const { cursor } = opened;
    const entry: OpenCursor = {
      ...opened,
      iterator: cursor[Symbol.asyncIterator](),
      isChangeStream: query.isChangeStream,
    };
    openCursors.set(reqId, entry);
    cursor.on("close", () => {
      Logger.Debug("Cursor #", reqId, "closed by server");
      if (!entry.expired?.()) {
        Release(reqId);
      }
    });
    cursor.init();
  }

  const entry = openCursors.get(reqId);
  assert(entry, `Cursor #${reqId} not found.`);
  if (entry.expired?.()) {
    Release(reqId);
    throw new QueryTimeoutError(entry.timeoutMs ?? 0);
  }
  entry.arm?.();
  const result = await entry.iterator
    .next()
    .finally(() => entry.disarm?.())
    .catch((error: unknown) => {
      const expired = entry.expired?.() ?? false;
      Release(reqId);
      throw expired ? new QueryTimeoutError(entry.timeoutMs ?? 0) : error;
    });

  if (result.done) {
    const expired = entry.expired?.() ?? false;
    Release(reqId);
    if (expired) {
      throw new QueryTimeoutError(entry.timeoutMs ?? 0);
    }
    return { done: true, value: undefined };
  }

  if (entry.isChangeStream && IsChangeEvent(result.value)) {
    return { done: false, value: mapChangeEvent(result.value) };
  }

  return { done: false, value: result.value };
}

/** A change feed event: the row before and after the change, either one absent or null. */
interface ChangeEvent {
  old_val?: unknown;
  new_val?: unknown;
}

/** Whether `value` is a change feed event; any object is one, its rows being of any type. */
function IsChangeEvent(value: unknown): value is ChangeEvent {
  return IsObject(value);
}

function mapChangeEvent(change: ChangeEvent) {
  if (change.old_val === null || change.old_val === undefined) {
    return { changeType: "added" as const, newValue: change.new_val };
  }
  if (change.new_val === null || change.new_val === undefined) {
    return { changeType: "removed" as const, oldValue: change.old_val };
  }
  return {
    changeType: "modified" as const,
    oldValue: change.old_val,
    newValue: change.new_val,
  };
}

export async function CloseCursor(reqId: number) {
  const entry = openCursors.get(reqId);
  if (entry) {
    Logger.Debug("Closing cursor #", reqId);
    openCursors.delete(reqId);
    await entry.cursor.close().catch(() => undefined);
    entry.release?.();
  }
}

export { executeTermJson } from "../../connection";
