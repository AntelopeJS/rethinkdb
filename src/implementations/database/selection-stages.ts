import { TermType } from "rethinkdb-ts/lib/proto/enums";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";

// oxlint-disable-next-line import/no-cycle -- stage handlers decode values; see expression.ts
import { DecodeFunction, DecodeValue } from "./expression";
import { type IndexedRead, indexOptions } from "./indexes";
import type { SelectionQuery } from "./selection";
import { allocateArgNumber, DecodingContext, type QueryStage } from "./utils";

type SelectionStageHandler = (query: SelectionQuery, stage: QueryStage) => void;

const SELECTION_STAGES = new Map<string, SelectionStageHandler>([
  [
    "get",
    (query, stage) => {
      const key = DecodeValue(stage.args[0], query.getContext());
      if (query.external) {
        query.resultType = "selection";
        query.singleElement = true;
        query.setTerm(query.external.get(key));
        return;
      }
      query.setGet(key);
    },
  ],
  [
    "getAll",
    (query, stage) => {
      query.resultType = "selection";
      const rawKeys = stage.args[0];
      const context = query.getContext();
      const keys = Array.isArray(rawKeys)
        ? rawKeys.map((k) => DecodeValue(k, context))
        : [DecodeValue(rawKeys, context)];
      if (query.external) {
        query.setTerm(
          query.external.getAll(query.schemaId, stage.options?.index, keys),
        );
        return;
      }
      const read: IndexedRead = {
        lookup: (source, target) => [
          TermType.GET_ALL,
          [source, ...keys.map(target.key)],
          indexOptions(target.index),
        ],
        matches: (value) => [
          TermType.CONTAINS,
          [[TermType.MAKE_ARRAY, keys], value],
        ],
      };
      query.setTerm(query.selectByIndex(stage.options?.index, read));
    },
  ],
  [
    "between",
    (query, stage) => {
      query.resultType = "selection";
      const low = DecodeValue(stage.args[0], query.getContext());
      const high = DecodeValue(stage.args[1], query.getContext());
      if (query.external) {
        query.setTerm(
          query.external.between(
            query.schemaId,
            stage.options?.index,
            low,
            high,
          ),
        );
        return;
      }
      const read: IndexedRead = {
        lookup: (source, target) => [
          TermType.BETWEEN,
          [source, target.key(low), target.key(high)],
          indexOptions(target.index),
        ],
        matches: (value) => [
          TermType.AND,
          [
            [TermType.GE, [value, low]],
            [TermType.LT, [value, high]],
          ],
        ],
      };
      query.setTerm(query.selectByIndex(stage.options?.index, read));
    },
  ],
  [
    "insert",
    (query, stage) => {
      query.resultType = "insert";
      query.setNewValue(DecodeValue(stage.args[0], new DecodingContext()));
      query.setConflictMode(stage.options?.conflict);
      query.setInsertRawArgs(stage.args[0]);
    },
  ],
  [
    "update",
    (query, stage) => {
      query.resultType = "update";
      if (query.external) {
        query.external.refuseMapper(stage.args[0]);
        query.setInsertRawArgs(stage.args[0]);
        return;
      }
      if (stage.args[0]?.stage === "func") {
        const argId = allocateArgNumber();
        const docVar: TermJson = [TermType.VAR, [argId]];
        const body = DecodeFunction(stage.args[0], new DecodingContext(), [
          docVar,
        ]);
        query.setNewValue([
          TermType.FUNC,
          [[TermType.MAKE_ARRAY, [argId]], body],
        ]);
      } else {
        query.setNewValue(DecodeValue(stage.args[0], new DecodingContext()));
      }
    },
  ],
  [
    "replace",
    (query, stage) => {
      query.resultType = "replace";
      query.setInsertRawArgs(stage.args[0]);
      query.setNewValue(DecodeValue(stage.args[0], new DecodingContext()));
    },
  ],
  [
    "delete",
    (query) => {
      query.resultType = "delete";
    },
  ],
]);

/** The handler of a key selection or write stage; undefined for any other stage. */
export function SelectionStageHandlerOf(
  name: string,
): SelectionStageHandler | undefined {
  return SELECTION_STAGES.get(name);
}
