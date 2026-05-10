import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import { TermType } from "rethinkdb-ts/lib/proto/enums";
import { DecodeFunction, DecodeValue } from "./query";
import {
  allocateArgNumber,
  type DecodingContext,
  type QueryStage,
} from "./utils";

type StageHandler =
  | number
  | ((expr: ExpressionBuilder, ...args: any[]) => TermJson);

interface ExpressionBuilder {
  value: TermJson;
  context: DecodingContext;
  options?: Record<string, any>;
}

const SIMPLE_STAGE_MAP: Record<string, number> = {
  default: TermType.DEFAULT,
  and: TermType.AND,
  or: TermType.OR,
  not: TermType.NOT,
  eq: TermType.EQ,
  ne: TermType.NE,
  add: TermType.ADD,
  sub: TermType.SUB,
  mul: TermType.MUL,
  div: TermType.DIV,
  mod: TermType.MOD,
  round: TermType.ROUND,
  ceil: TermType.CEIL,
  floor: TermType.FLOOR,
  bit_and: TermType.BIT_AND,
  bit_or: TermType.BIT_OR,
  bit_xor: TermType.BIT_XOR,
  bit_not: TermType.BIT_NOT,
  bit_lshift: TermType.BIT_SAL,
  bit_rshift: TermType.BIT_SAR,
  cmp_gt: TermType.GT,
  cmp_ge: TermType.GE,
  cmp_lt: TermType.LT,
  cmp_le: TermType.LE,
  str_upcase: TermType.UPCASE,
  str_downcase: TermType.DOWNCASE,
  str_concat: TermType.ADD,
  arr_empty: TermType.IS_EMPTY,
  arr_count: TermType.COUNT,
  arr_sum: TermType.SUM,
  arr_avg: TermType.AVG,
  arr_min: TermType.MIN,
  arr_max: TermType.MAX,
  arr_includes: TermType.CONTAINS,
  obj_merge: TermType.MERGE,
  obj_keys: TermType.KEYS,
  obj_values: TermType.VALUES,
  date_tod: TermType.TIME_OF_DAY,
  date_year: TermType.YEAR,
  date_month: TermType.MONTH,
  date_day: TermType.DAY,
  date_dow: TermType.DAY_OF_WEEK,
  date_doy: TermType.DAY_OF_YEAR,
  date_hours: TermType.HOURS,
  date_minutes: TermType.MINUTES,
  date_seconds: TermType.SECONDS,
  date_epoch: TermType.TO_EPOCH_TIME,
  date_during: TermType.DURING,
};

const COMPLEX_STAGE_MAP: Record<string, StageHandler> = {
  arg: (expr, num: number) => {
    const provider = expr.context.args[num];
    if (provider) {
      return provider([{ stage: "arg", args: [num] }]);
    }
    return [TermType.VAR, [num]];
  },
  constant: (_expr, constant: TermJson) => constant,
  date_with_timezone: (expr, timezone: TermJson) => [
    TermType.IN_TIMEZONE,
    [expr.value, timezone],
  ],
  str_split: (expr) => {
    const sep = expr.options?.separator ?? " ";
    const result: TermJson = [TermType.SPLIT, [expr.value, sep]];
    if (expr.options?.maxSplits) {
      return [TermType.SLICE, [result, 0, expr.options.maxSplits]];
    }
    return result;
  },
  str_len: (expr) => [
    TermType.FUNCALL,
    [
      [
        TermType.FUNC,
        [
          [TermType.MAKE_ARRAY, [allocateArgNumber()]],
          [TermType.COUNT, [[TermType.SPLIT, [expr.value, ""]]]],
        ],
      ],
      expr.value,
    ],
  ],
  str_match: (expr, regex: TermJson) => {
    const argId = allocateArgNumber();
    return [
      TermType.FUNCALL,
      [
        [
          TermType.FUNC,
          [
            [TermType.MAKE_ARRAY, [argId]],
            [TermType.NE, [[TermType.MATCH, [expr.value, regex]], null]],
          ],
        ],
        expr.value,
      ],
    ];
  },
  arr_index: (expr, key: TermJson) => [TermType.BRACKET, [expr.value, key]],
  arr_slice: (expr, start: TermJson, end?: TermJson) => {
    if (end !== undefined) {
      return [TermType.SLICE, [expr.value, start, end]];
    }
    return [TermType.SLICE, [expr.value, start]];
  },
  obj_index: (expr, key: TermJson, def?: TermJson) => {
    const bracket: TermJson = [TermType.BRACKET, [expr.value, key]];
    if (def !== undefined) {
      return [TermType.DEFAULT, [bracket, def]];
    }
    return bracket;
  },
};

type FuncStageHandler = (
  expr: ExpressionBuilder,
  stage: QueryStage,
) => TermJson;

const FUNC_STAGE_MAP: Record<string, FuncStageHandler> = {
  obj_has: (expr, stage) => {
    const fields = stage.args[0] as string[];
    return [TermType.HAS_FIELDS, [expr.value, ...fields]];
  },
  arr_filter: (expr, stage) => {
    const func = stage.args[0];
    const argId = allocateArgNumber();
    const row: TermJson = [TermType.VAR, [argId]];
    const body = DecodeFunction(func, expr.context, [row]);
    return [
      TermType.FILTER,
      [expr.value, [TermType.FUNC, [[TermType.MAKE_ARRAY, [argId]], body]]],
    ];
  },
  arr_map: (expr, stage) => {
    const func = stage.args[0];
    const argId = allocateArgNumber();
    const row: TermJson = [TermType.VAR, [argId]];
    const body = DecodeFunction(func, expr.context, [row]);
    return [
      TermType.MAP,
      [expr.value, [TermType.FUNC, [[TermType.MAKE_ARRAY, [argId]], body]]],
    ];
  },
};

function applySimpleStage(
  prev: TermJson,
  termType: number,
  args: TermJson[],
): TermJson {
  if (args.length === 0) {
    return [termType, [prev]];
  }
  return [termType, [prev, ...args]];
}

export function decodeExpression(
  stages: QueryStage[],
  context: DecodingContext,
  startValue: TermJson = [TermType.IMPLICIT_VAR],
): TermJson {
  const builder: ExpressionBuilder = { value: startValue, context };

  for (const stage of stages) {
    builder.options = stage.options;
    const funcHandler = FUNC_STAGE_MAP[stage.stage];
    if (funcHandler) {
      builder.value = funcHandler(builder, stage);
      continue;
    }
    const decodedArgs = stage.args.map((arg) => DecodeValue(arg, context));
    const simpleType = SIMPLE_STAGE_MAP[stage.stage];
    if (simpleType !== undefined) {
      builder.value = applySimpleStage(builder.value, simpleType, decodedArgs);
      continue;
    }
    const complexHandler = COMPLEX_STAGE_MAP[stage.stage];
    if (complexHandler) {
      builder.value = (complexHandler as any)(builder, ...decodedArgs);
      continue;
    }
    throw new Error(`Unimplemented expression stage: ${stage.stage}`);
  }

  delete builder.options;
  return builder.value;
}
