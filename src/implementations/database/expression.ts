import assert from "node:assert";
import { TermType } from "rethinkdb-ts/lib/proto/enums";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import { Query, ValueProxy } from "@antelopejs/interface-database";
import type { Value } from "@antelopejs/interface-database/common";

// The ReQL compiler is one mutually recursive unit: decoding a value can hit a sub-query,
// building a sub-query applies stream stages, and a stream stage decodes values again.
// The cycle is the recursion, not an accident of where the code sits.
// oxlint-disable-next-line import/no-cycle -- value decoding recurses into sub-query building
import { SelectionQuery } from "./selection";
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

function decodeExpression(
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

export function DecodeValue(
  value: Value<unknown>,
  context: DecodingContext,
): TermJson {
  if (value instanceof ValueProxy) {
    return decodeExpression(value.build(), context);
  }

  if (value instanceof Query) {
    return decodeSubquery(value.build(), context);
  }

  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      return [
        TermType.MAKE_ARRAY,
        value.map((val) => DecodeValue(val, context)),
      ] as TermJson;
    }
    if (value instanceof Date) {
      return dateToReql(value);
    }
    if (value instanceof Object) {
      return Object.fromEntries(
        Object.entries(value).map(([key, val]) => [
          key,
          DecodeValue(val, context),
        ]),
      );
    }
  }

  if (value === undefined) {
    return undefined as any;
  }

  return value as TermJson;
}

function dateToReql(date: Date): TermJson {
  const timeZone = date.getTimezoneOffset();
  return {
    $reql_type$: "TIME",
    epoch_time: +date / 1000,
    timezone: `${timeZone <= 0 ? "+" : "-"}${Math.abs(Math.floor(timeZone / 60))
      .toFixed(0)
      .padStart(2, "0")}:${Math.abs(timeZone % 60)
      .toFixed(0)
      .padStart(2, "0")}`,
  };
}

function decodeSubquery(
  stages: QueryStage[],
  context: DecodingContext,
): TermJson {
  if (stages[0]?.stage === "arg") {
    const num = stages[0].args[0];
    const provider = context.args[num];
    assert(provider, "Unknown arg used");
    return provider(stages);
  }
  return SelectionQuery.buildTermJson(stages, context);
}

export function DecodeFunction(
  func: QueryStage,
  context: DecodingContext,
  argTerms: TermJson[],
): TermJson {
  const argNumbers: number[] = func.args[0];
  const oldArgs: Record<number, any> = {};
  for (let i = 0; i < argNumbers.length; ++i) {
    oldArgs[argNumbers[i]] = context.args[argNumbers[i]];
    const argTerm = argTerms[i];
    context.args[argNumbers[i]] = () => argTerm;
  }
  const val = DecodeValue(func.args[1], context);
  for (let i = 0; i < argNumbers.length; ++i) {
    if (oldArgs[argNumbers[i]] !== undefined) {
      context.args[argNumbers[i]] = oldArgs[argNumbers[i]];
    } else {
      delete context.args[argNumbers[i]];
    }
  }
  return val;
}
