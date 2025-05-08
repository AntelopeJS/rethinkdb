import { internal as internalRuntime } from '@ajs.local/database/beta/runtime';
import { TermJson } from 'rethinkdb-ts/lib/internal-types';
import { TranslationContext, allocateArgNumber, isComplexTerm, translateArg } from '.';
import { TermType } from 'rethinkdb-ts/lib/proto/enums';
import { JoinType } from '@ajs.local/database/beta';

function isFieldEqualityCheck(term: TermJson): [string, string] | undefined {
  if (isComplexTerm(term, TermType.FUNC)) {
    const argIds: number[] = (<any>term)[1][0][1];
    const names: Record<number, string> = {};
    const body = term[1]![1];
    if (isComplexTerm(body, TermType.EQ)) {
      const left = body[1]![0];
      const right = body[1]![1];
      if (isComplexTerm(left, TermType.BRACKET) && isComplexTerm(right, TermType.BRACKET)) {
        const leftId = left[1]![0];
        const rightId = right[1]![0];
        if (
          isComplexTerm(leftId, TermType.VAR) &&
          isComplexTerm(rightId, TermType.VAR) &&
          typeof left[1]![1] === 'string' &&
          typeof right[1]![1] === 'string'
        ) {
          names[<number>leftId[1]![0]] = left[1]![1];
          names[<number>rightId[1]![0]] = right[1]![1];
          return [names[argIds[0]], names[argIds[1]]];
        }
      }
    }
  }
}

function maybeDefault(condition: boolean, val: TermJson) {
  return condition ? [TermType.DEFAULT, [val, null]] : val;
}

function rbracket(row: TermJson, key: TermJson) {
  return [TermType.BRACKET, [row, key]];
}

function rvar(key: number) {
  return [TermType.VAR, [key]];
}

function rgetall(b: TermJson, key: TermJson, right: string) {
  return [TermType.GET_ALL, [b, key], { index: right }];
}

function rfilter(source: TermJson, predicate: TermJson) {
  return [TermType.FILTER, [source, predicate]];
}

function rfunc(context: TranslationContext, numargs: number, body: (...args: TermJson[]) => TermJson) {
  const args = [];
  for (let i = 0; i < numargs; ++i) {
    args[i] = allocateArgNumber(context);
  }
  return [TermType.FUNC, [[TermType.MAKE_ARRAY, args], body(...args.map((a) => rvar(a)))]];
}

function rfuncall(...args: TermJson[]) {
  return [TermType.FUNCALL, args];
}

function rfuncremap(
  context: TranslationContext,
  func: TermJson,
  newnumargs: number,
  remapper: (...args: TermJson[]) => TermJson[],
) {
  return rfunc(context, newnumargs, (...args) => rfuncall(func, ...remapper(...args)));
}

function rconcatmap(source: TermJson, mapper: TermJson) {
  return [TermType.CONCAT_MAP, [source, mapper]];
}

function rmap(source: TermJson, mapper: TermJson) {
  return [TermType.MAP, [source, mapper]];
}

function splitMapper(context: TranslationContext, mapper: TermJson, leftOpt?: boolean, rightOpt?: boolean) {
  return rfuncremap(context, mapper, 1, (argSplitter) => [
    maybeDefault(leftOpt!, rbracket(argSplitter, 'left')),
    maybeDefault(rightOpt!, rbracket(argSplitter, 'right')),
  ]);
}

function concatFilter(context: TranslationContext, b: TermJson, rowA: TermJson, predicate: TermJson) {
  return rfilter(
    b,
    rfuncremap(context, predicate, 1, (rowB) => [rowA, rowB]),
  );
}

function guaranteeNotEmpty(context: TranslationContext, stream: TermJson) {
  return rfuncall(
    rfunc(context, 1, (ar) => [TermType.BRANCH, [[TermType.IS_EMPTY, [ar]], [TermType.MAKE_ARRAY, [null]], ar]]),
    [TermType.COERCE_TO, [stream, 'array']],
  );
}

function concatMapper(
  context: TranslationContext,
  mapper: TermJson,
  a: TermJson,
  innerGet: (row: TermJson) => TermJson,
) {
  return rconcatmap(
    a,
    rfunc(context, 1, (rowA) =>
      rmap(
        innerGet(rowA),
        rfuncremap(context, mapper, 1, (rowB) => [rowA, rowB]),
      ),
    ),
  );
}

function flipArguments(func: TermJson) {
  const args = (<any>func)[1][0][1] as number[];
  [args[0], args[1]] = [args[1], args[0]];
}

export function join(prev: TermJson, term: internalRuntime.QueryBuilderContext[number], context: TranslationContext) {
  let other = translateArg(term.args[0], context);
  const type = translateArg(term.args[1], context) as JoinType;
  const mapper = translateArg(term.args[2], context);
  const predicate = term.args[3] && translateArg(term.args[3], context);

  const keys = isFieldEqualityCheck(predicate);
  const invertAll = () => {
    [prev, other] = [other, prev];
    if (keys) {
      [keys[0], keys[1]] = [keys[1], keys[0]];
    }
    flipArguments(predicate);
    flipArguments(mapper);
    return true;
  };
  const aIsTable = isComplexTerm(prev, TermType.TABLE);
  const bIsTable = isComplexTerm(other, TermType.TABLE);
  switch (type) {
    case JoinType.Cross:
      return crossJoin(context, prev, other, mapper);
    case JoinType.Inner:
      if (keys && (bIsTable || (aIsTable && invertAll()))) {
        return innerJoinFast(context, prev, keys[0], other, keys[1], mapper);
      }
      return innerJoin(context, prev, other, predicate, mapper);
    case JoinType.Right:
      invertAll();
    // eslint-disable-next-line no-fallthrough
    case JoinType.Left:
      if (keys && (bIsTable || (aIsTable && invertAll()))) {
        return leftJoinFast(context, prev, keys[0], other, keys[1], mapper);
      }
      return leftJoin(context, prev, other, predicate, mapper);
    case JoinType.FullOuter:
      return fullJoin(context, prev, other, predicate, keys, mapper);
    case JoinType.RightExcl:
      invertAll();
    // eslint-disable-next-line no-fallthrough
    case JoinType.LeftExcl:
      if (keys && (bIsTable || (aIsTable && invertAll()))) {
        return leftJoinExclFast(context, prev, keys[0], other, keys[1], mapper);
      }
      return leftJoinExcl(context, prev, other, predicate, mapper);
    case JoinType.FullExcl:
      return fullJoinExcl(context, prev, other, predicate, keys, mapper);
  }
}

function crossJoin(context: TranslationContext, a: TermJson, b: TermJson, mapper: TermJson): TermJson {
  return rconcatmap(
    a,
    rfunc(context, 1, (rowA) =>
      rmap(
        b,
        rfuncremap(context, mapper, 1, (rowB) => [rowA, rowB]),
      ),
    ),
  );
}

function innerJoin(context: TranslationContext, a: TermJson, b: TermJson, predicate: TermJson, mapper: TermJson) {
  return [TermType.MAP, [[TermType.INNER_JOIN, [a, b, predicate]], splitMapper(context, mapper)]];
}

function innerJoinFast(
  context: TranslationContext,
  a: TermJson,
  keyA: string,
  b: TermJson,
  keyB: string,
  mapper: TermJson,
) {
  return [TermType.MAP, [[TermType.EQ_JOIN, [a, keyA, b], { index: keyB }], splitMapper(context, mapper, false, true)]];
}

function leftJoin(context: TranslationContext, a: TermJson, b: TermJson, predicate: TermJson, mapper: TermJson) {
  return [TermType.MAP, [[TermType.OUTER_JOIN, [a, b, predicate]], splitMapper(context, mapper, false, true)]];
}

function leftJoinFast(
  context: TranslationContext,
  a: TermJson,
  keyA: string,
  b: TermJson,
  keyB: string,
  mapper: TermJson,
) {
  return concatMapper(context, mapper, a, (row) => guaranteeNotEmpty(context, rgetall(b, rbracket(row, keyA), keyB)));
}

function leftJoinExcl(context: TranslationContext, a: TermJson, b: TermJson, predicate: TermJson, mapper: TermJson) {
  return rmap(
    rfilter(
      a,
      rfunc(context, 1, (rowA) => [TermType.IS_EMPTY, [concatFilter(context, b, rowA, predicate)]]),
    ),
    rfuncremap(context, mapper, 1, (rowA) => [rowA, null]),
  );
}

function leftJoinExclFast(
  context: TranslationContext,
  a: TermJson,
  keyA: string,
  b: TermJson,
  keyB: string,
  mapper: TermJson,
) {
  return rmap(
    rfilter(
      a,
      rfunc(context, 1, (tmp) => [TermType.IS_EMPTY, [rgetall(b, rbracket(tmp, keyA), keyB)]]),
    ),
    rfuncremap(context, mapper, 1, (rowA) => [rowA, null]),
  );
}

function fullJoin(
  _context: TranslationContext,
  _a: TermJson,
  _b: TermJson,
  _predicate: TermJson,
  _keys: [string, string] | undefined,
  _mapper: TermJson,
) {
  return [];
}

function fullJoinExcl(
  _context: TranslationContext,
  _a: TermJson,
  _b: TermJson,
  _predicate: TermJson,
  _keys: [string, string] | undefined,
  _mapper: TermJson,
) {
  return [];
}
