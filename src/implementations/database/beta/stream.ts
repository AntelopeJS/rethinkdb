import { TermType } from 'rethinkdb-ts/lib/proto/enums';
import { TermJson } from 'rethinkdb-ts/lib/internal-types';
import { DecodingContext, QueryStage, allocateArgNumber } from './utils';
import { DecodeFunction, DecodeValue } from './query';
import { Stream } from '@ajs.local/database/beta';
import { SelectionQuery } from './selection';
import { GetIndex, IsRowLevel } from './schema';

type StreamStageHandler = (
  prev: TermJson,
  stage: QueryStage,
  context: DecodingContext,
  schemaId: string,
  tableName: string,
) => TermJson;

const STREAM_STAGE_MAP: Record<string, StreamStageHandler> = {
  changes: handleChanges,
  key: handleKey,
  default: handleDefault,
  map: handleMap,
  filter: handleFilter,
  pluck: handlePluck,
  without: handleWithout,
  join: handleJoin,
  lookup: handleLookup,
  group: handleGroup,
  orderBy: handleOrderBy,
  slice: handleSlice,
  nth: handleNth,
  count: handleCount,
  sum: handleSum,
  avg: handleAvg,
  min: handleMin,
  max: handleMax,
  distinct: handleDistinct,
};

export function applyStreamStages(
  prev: TermJson,
  stages: QueryStage[],
  context: DecodingContext,
  schemaId: string,
  tableName: string,
  initialSingleElement = false,
): { term: TermJson; isChangeStream: boolean; singleElement: boolean } {
  let term = prev;
  let isChangeStream = false;
  let singleElement = initialSingleElement;

  for (const stage of stages) {
    if (stage.stage === 'changes') {
      isChangeStream = true;
    }
    if (stage.stage === 'nth') {
      singleElement = true;
    }
    if (stage.stage === 'map' && singleElement) {
      term = handleMapSingle(term, stage, context);
      continue;
    }
    const handler = STREAM_STAGE_MAP[stage.stage];
    if (!handler) {
      throw new Error('Unimplemented stream stage: ' + stage.stage);
    }
    term = handler(term, stage, context, schemaId, tableName);
  }

  return { term, isChangeStream, singleElement };
}

function handleChanges(prev: TermJson): TermJson {
  return [TermType.CHANGES, [prev]];
}

function handleKey(prev: TermJson, stage: QueryStage): TermJson {
  const fieldName = stage.args[0];
  const defaultValue = stage.args[1];
  const bracket: TermJson = [TermType.BRACKET, [prev, fieldName]];
  if (defaultValue !== undefined) {
    return [TermType.DEFAULT, [bracket, defaultValue]];
  }
  return bracket;
}

function handleDefault(prev: TermJson, stage: QueryStage, context: DecodingContext): TermJson {
  return [TermType.DEFAULT, [prev, DecodeValue(stage.args[0], context)]];
}

function handleMap(prev: TermJson, stage: QueryStage, context: DecodingContext): TermJson {
  const func = stage.args[0];
  const argId = allocateArgNumber();
  const row: TermJson = [TermType.VAR, [argId]];

  const body = DecodeFunction(func, context, [row]);
  return [TermType.MAP, [prev, [TermType.FUNC, [[TermType.MAKE_ARRAY, [argId]], body]]]];
}

function handleMapSingle(prev: TermJson, stage: QueryStage, context: DecodingContext): TermJson {
  const func = stage.args[0];
  const argId = allocateArgNumber();
  const row: TermJson = [TermType.VAR, [argId]];

  const body = DecodeFunction(func, context, [row]);
  const funcTerm: TermJson = [TermType.FUNC, [[TermType.MAKE_ARRAY, [argId]], body]];
  return [TermType.FUNCALL, [funcTerm, prev]];
}

function handleFilter(prev: TermJson, stage: QueryStage, context: DecodingContext): TermJson {
  const func = stage.args[0];
  const argId = allocateArgNumber();
  const row: TermJson = [TermType.VAR, [argId]];

  const body = DecodeFunction(func, context, [row]);
  return [TermType.FILTER, [prev, [TermType.FUNC, [[TermType.MAKE_ARRAY, [argId]], body]]]];
}

function handlePluck(prev: TermJson, stage: QueryStage): TermJson {
  const fields = stage.args[0];
  return [TermType.PLUCK, [prev, ...fields]];
}

function handleWithout(prev: TermJson, stage: QueryStage): TermJson {
  const fields = stage.args[0];
  return [TermType.WITHOUT, [prev, ...fields]];
}

function handleJoin(prev: TermJson, stage: QueryStage, context: DecodingContext): TermJson {
  const innerOnly = stage.options?.innerOnly ?? false;
  const rightStages = (stage.args[0] as Stream<any>).build();
  const rightTerm = SelectionQuery.buildTermJson(rightStages, context);
  const predicate = stage.args[1];
  const mapper = stage.args[2];

  const joinType = innerOnly ? TermType.INNER_JOIN : TermType.OUTER_JOIN;

  const predArgId = allocateArgNumber();
  const predArgId2 = allocateArgNumber();
  const predLeft: TermJson = [TermType.VAR, [predArgId]];
  const predRight: TermJson = [TermType.VAR, [predArgId2]];
  const predBody = DecodeFunction(predicate, context, [predLeft, predRight]);
  const predicateTerm: TermJson = [TermType.FUNC, [[TermType.MAKE_ARRAY, [predArgId, predArgId2]], predBody]];

  const joinResult: TermJson = [joinType, [prev, rightTerm, predicateTerm]];

  const mapArgId = allocateArgNumber();
  const mapRow: TermJson = [TermType.VAR, [mapArgId]];
  const leftAccess: TermJson = [TermType.BRACKET, [mapRow, 'left']];
  const rightAccess: TermJson = innerOnly
    ? [TermType.BRACKET, [mapRow, 'right']]
    : [TermType.DEFAULT, [[TermType.BRACKET, [mapRow, 'right']], null]];

  const mapBody = DecodeFunction(mapper, context, [leftAccess, rightAccess]);
  const mapperTerm: TermJson = [TermType.FUNC, [[TermType.MAKE_ARRAY, [mapArgId]], mapBody]];

  return [TermType.MAP, [joinResult, mapperTerm]];
}

function handleLookup(prev: TermJson, stage: QueryStage, context: DecodingContext): TermJson {
  const rightStages = (stage.args[0] as Stream<any>).build();
  const rightQuery = SelectionQuery.decode(rightStages, context);
  const rightTerm = rightQuery.buildTerm();
  const localKey = stage.options.localKey as string;
  const otherKey = stage.options.otherKey as string;

  const mapArgId = allocateArgNumber();
  const row: TermJson = [TermType.VAR, [mapArgId]];
  const localField: TermJson = [TermType.BRACKET, [row, localKey]];

  let lookupResult: TermJson;
  if (rightQuery.isRowLevel()) {
    const filterArgId = allocateArgNumber();
    const filterDoc: TermJson = [TermType.VAR, [filterArgId]];
    const filterFn: TermJson = [
      TermType.FUNC,
      [
        [TermType.MAKE_ARRAY, [filterArgId]],
        [TermType.EQ, [[TermType.BRACKET, [filterDoc, otherKey]], localField]],
      ],
    ];
    lookupResult = [TermType.FILTER, [rightTerm, filterFn]];
  } else {
    lookupResult = [TermType.GET_ALL, [rightTerm, localField], { index: otherKey }];
  }
  const coerced: TermJson = [TermType.COERCE_TO, [lookupResult, 'array']];

  const isArray: TermJson = [TermType.TYPE_OF, [localField]];
  const branchResult: TermJson = [
    TermType.BRANCH,
    [[TermType.EQ, [isArray, 'ARRAY']], coerced, [TermType.NTH, [coerced, 0]]],
  ];

  const merged: TermJson = [TermType.MERGE, [row, { [localKey]: branchResult }]];

  return [TermType.MAP, [prev, [TermType.FUNC, [[TermType.MAKE_ARRAY, [mapArgId]], merged]]]];
}

function handleGroup(
  prev: TermJson,
  stage: QueryStage,
  context: DecodingContext,
  schemaId: string,
  tableName: string,
): TermJson {
  const field = stage.options.index;
  const func = stage.args[0];
  const argNumbers: number[] = func.args[0];

  const mapArgId = allocateArgNumber();
  const row: TermJson = [TermType.VAR, [mapArgId]];
  const reductionAccess: TermJson = [TermType.BRACKET, [row, 'reduction']];
  const groupAccess: TermJson = [TermType.BRACKET, [row, 'group']];

  const oldArgs0 = context.args[argNumbers[0]];
  const oldArgs1 = context.args[argNumbers[1]];

  context.args[argNumbers[0]] = (subQuery: QueryStage[]) => {
    if (subQuery.length <= 1) {
      return reductionAccess;
    }
    return applyStreamStages(reductionAccess, subQuery.slice(1), context, schemaId, tableName).term;
  };
  context.args[argNumbers[1]] = () => groupAccess;

  const body = DecodeValue(func.args[1], context);

  if (oldArgs0 !== undefined) {
    context.args[argNumbers[0]] = oldArgs0;
  } else {
    delete context.args[argNumbers[0]];
  }
  if (oldArgs1 !== undefined) {
    context.args[argNumbers[1]] = oldArgs1;
  } else {
    delete context.args[argNumbers[1]];
  }

  const mapperFunc: TermJson = [TermType.FUNC, [[TermType.MAKE_ARRAY, [mapArgId]], body]];

  const grouped: TermJson = [TermType.GROUP, [prev, field]];
  const ungrouped: TermJson = [TermType.UNGROUP, [grouped]];

  return [TermType.MAP, [ungrouped, mapperFunc]];
}

function handleOrderBy(
  prev: TermJson,
  stage: QueryStage,
  _context: DecodingContext,
  schemaId: string,
  tableName: string,
): TermJson {
  const index = GetIndex(schemaId, tableName, stage.options.index);
  const direction = stage.options.direction === 'desc' ? TermType.DESC : TermType.ASC;
  const indexFields = index.fields ?? [stage.options.index];
  const fields = indexFields.map((f) => [direction, [f]]);

  if (fields.length === 1) {
    return [TermType.ORDER_BY, [prev, fields[0]]];
  }
  return [TermType.ORDER_BY, [prev, ...fields]];
}

function handleSlice(prev: TermJson, stage: QueryStage, context: DecodingContext): TermJson {
  const offset = DecodeValue(stage.args[0], context);
  const count = stage.args[1] !== undefined ? DecodeValue(stage.args[1], context) : undefined;

  let result = prev;
  if (offset !== 0) {
    result = [TermType.SKIP, [result, offset]];
  }
  if (count !== undefined) {
    result = [TermType.LIMIT, [result, count]];
  }
  return result;
}

function handleNth(prev: TermJson, stage: QueryStage, context: DecodingContext): TermJson {
  const n = DecodeValue(stage.args[0], context);
  return [TermType.NTH, [prev, n]];
}

function handleCount(prev: TermJson, stage: QueryStage, _context: DecodingContext, schemaId: string): TermJson {
  if (stage.options?.field) {
    if (IsRowLevel(schemaId)) {
      const argId = allocateArgNumber();
      const mapped: TermJson = [TermType.MAP, [prev, [TermType.FUNC, [[TermType.MAKE_ARRAY, [argId]], [TermType.BRACKET, [[TermType.VAR, [argId]], stage.options.field]]]]]];
      return [TermType.COUNT, [[TermType.DISTINCT, [mapped]]]];
    }
    return [TermType.COUNT, [[TermType.DISTINCT, [prev], { index: stage.options.field }]]];
  }
  return [TermType.COUNT, [prev]];
}

function handleSum(prev: TermJson, stage: QueryStage): TermJson {
  if (stage.options?.field) {
    return [TermType.SUM, [prev, stage.options.field]];
  }
  return [TermType.SUM, [prev]];
}

function handleAvg(prev: TermJson, stage: QueryStage): TermJson {
  if (stage.options?.field) {
    return [TermType.AVG, [prev, stage.options.field]];
  }
  return [TermType.AVG, [prev]];
}

function handleMin(prev: TermJson, stage: QueryStage): TermJson {
  if (stage.options?.field) {
    const field = stage.options.field;
    return [TermType.BRACKET, [[TermType.MIN, [prev, field]], field]];
  }
  return [TermType.MIN, [prev]];
}

function handleMax(prev: TermJson, stage: QueryStage): TermJson {
  if (stage.options?.field) {
    const field = stage.options.field;
    return [TermType.BRACKET, [[TermType.MAX, [prev, field]], field]];
  }
  return [TermType.MAX, [prev]];
}

function handleDistinct(prev: TermJson, stage: QueryStage, _context: DecodingContext, schemaId: string): TermJson {
  if (stage.options?.field) {
    if (IsRowLevel(schemaId)) {
      const argId = allocateArgNumber();
      const mapped: TermJson = [TermType.MAP, [prev, [TermType.FUNC, [[TermType.MAKE_ARRAY, [argId]], [TermType.BRACKET, [[TermType.VAR, [argId]], stage.options.field]]]]]];
      return [TermType.DISTINCT, [mapped]];
    }
    return [TermType.DISTINCT, [prev], { index: stage.options.field }];
  }
  return [TermType.DISTINCT, [prev]];
}

export { STREAM_STAGE_MAP };
