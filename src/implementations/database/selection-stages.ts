import { TermType } from "rethinkdb-ts/lib/proto/enums";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";

// oxlint-disable-next-line import/no-cycle -- stage handlers decode values; see expression.ts
import { DecodeFunction, DecodeValue } from "./expression";
import { type IndexedRead, indexOptions } from "./indexes";
import type { SelectionQuery } from "./selection";
import {
  allocateArgNumber,
  DecodingContext,
  IsUpdateFunction,
  type QueryStage,
  StageNamed,
} from "./utils";

type SelectionStageHandler = (query: SelectionQuery, stage: QueryStage) => void;

const SELECTION_STAGES = new Map<string, SelectionStageHandler>([
  [
    "get",
    (query, stage) => {
      const [rawKey] = StageNamed(stage, "get").args;
      const key = DecodeValue(rawKey, query.getContext());
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
      const {
        args: [rawKeys],
        options,
      } = StageNamed(stage, "getAll");
      query.resultType = "selection";
      const context = query.getContext();
      const keys = Array.isArray(rawKeys)
        ? rawKeys.map((k) => DecodeValue(k, context))
        : [DecodeValue(rawKeys, context)];
      if (query.external) {
        query.setTerm(
          query.external.getAll(query.schemaId, options?.index, keys),
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
      query.setTerm(query.selectByIndex(options?.index, read));
    },
  ],
  [
    "between",
    (query, stage) => {
      const {
        args: [rawLow, rawHigh],
        options,
      } = StageNamed(stage, "between");
      query.resultType = "selection";
      const low = DecodeValue(rawLow, query.getContext());
      const high = DecodeValue(rawHigh, query.getContext());
      if (query.external) {
        query.setTerm(
          query.external.between(query.schemaId, options?.index, low, high),
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
      query.setTerm(query.selectByIndex(options?.index, read));
    },
  ],
  [
    "insert",
    (query, stage) => {
      const {
        args: [documents],
        options,
      } = StageNamed(stage, "insert");
      query.resultType = "insert";
      query.setNewValue(DecodeValue(documents, new DecodingContext()));
      query.setConflictMode(options?.conflict);
      query.setInsertRawArgs(documents);
    },
  ],
  [
    "update",
    (query, stage) => {
      const [document] = StageNamed(stage, "update").args;
      query.resultType = "update";
      if (query.external) {
        query.external.refuseMapper(document);
        query.setInsertRawArgs(document);
        return;
      }
      if (IsUpdateFunction(document)) {
        const argId = allocateArgNumber();
        const docVar: TermJson = [TermType.VAR, [argId]];
        const body = DecodeFunction(document, new DecodingContext(), [docVar]);
        query.setNewValue([
          TermType.FUNC,
          [[TermType.MAKE_ARRAY, [argId]], body],
        ]);
      } else {
        query.setNewValue(DecodeValue(document, new DecodingContext()));
      }
    },
  ],
  [
    "replace",
    (query, stage) => {
      const [document] = StageNamed(stage, "replace").args;
      query.resultType = "replace";
      query.setInsertRawArgs(document);
      query.setNewValue(DecodeValue(document, new DecodingContext()));
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
