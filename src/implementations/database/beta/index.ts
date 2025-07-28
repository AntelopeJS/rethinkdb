import { internal as internalRuntime } from '@ajs.local/database/beta/runtime';
import assert from 'assert';
import { SendQuery } from '../../../connection';
import { ComplexTermJson, TermJson } from 'rethinkdb-ts/lib/internal-types';
import { Cursor } from 'rethinkdb-ts/lib/response/cursor';
import { TermType } from 'rethinkdb-ts/lib/proto/enums';
import { join } from './join';

let nextArgNumber = 0;
export interface TranslationContext {
  vars: { name: string; ref: [any] }[];
  argMap: Map<number, number>;
  referencedArgs: Set<number>;
  autoCoerce?: boolean;
}

export function allocateArgNumber(context: TranslationContext, original?: number) {
  if (original !== undefined && context.argMap.has(original)) {
    return context.argMap.get(original)!;
  }
  const arg = nextArgNumber++;
  if (original !== undefined) {
    context.argMap.set(original, arg);
  }
  return arg;
}

export function isComplexTerm(term: TermJson, name?: number): term is ComplexTermJson {
  return Array.isArray(term) && (name === undefined || term[0] === name);
}

const termTranslationTable: Record<
  string,
  | number
  | ((prev: TermJson, term: internalRuntime.QueryBuilderContext[number], context: TranslationContext) => TermJson)
> = {
  arg: (_, term, context) => {
    const allocatedArg = allocateArgNumber(context, term.args[0].value);
    context.referencedArgs.add(allocatedArg);
    return [TermType.VAR, [allocatedArg]];
  },
  index: TermType.BRACKET,
  default: TermType.DEFAULT,
  do: (prev, term, context) => [TermType.FUNCALL, [translateArg(term.args[0], context), prev]],
  append: TermType.APPEND,
  prepend: TermType.PREPEND,
  value: (prev) => prev,

  changes: TermType.CHANGES,
  innerJoin: (prev, term, context) => {
    const other = translateArg(term.args[0], context);
    const mapper = translateArg(term.args[1], context);
    const predicate = translateArg(term.args[2], context);
    const argSplitter = allocateArgNumber(context);
    return [
      TermType.MAP,
      [
        [TermType.INNER_JOIN, [prev, other, predicate]],
        [
          TermType.FUNC,
          [
            [TermType.MAKE_ARRAY, [argSplitter]],
            [
              TermType.FUNCALL,
              [
                mapper,
                [TermType.BRACKET, [[TermType.VAR, [argSplitter]], 'left']],
                [TermType.BRACKET, [[TermType.VAR, [argSplitter]], 'right']],
              ],
            ],
          ],
        ],
      ],
    ];
  },
  outerJoin: (prev, term, context) => {
    const other = translateArg(term.args[0], context);
    const mapper = translateArg(term.args[1], context);
    const predicate = translateArg(term.args[2], context);
    const argSplitter = allocateArgNumber(context);
    return [
      TermType.MAP,
      [
        [TermType.OUTER_JOIN, [prev, other, predicate]],
        [
          TermType.FUNC,
          [
            [TermType.MAKE_ARRAY, [argSplitter]],
            [
              TermType.FUNCALL,
              [
                mapper,
                [TermType.DEFAULT, [[TermType.BRACKET, [[TermType.VAR, [argSplitter]], 'left']], null]],
                [TermType.DEFAULT, [[TermType.BRACKET, [[TermType.VAR, [argSplitter]], 'right']], null]],
              ],
            ],
          ],
        ],
      ],
    ];
  },
  eqJoin: (prev, term, context) => {
    const other = translateArg(term.args[0], context);
    const mapper = translateArg(term.args[1], context);
    const leftField = translateArg(term.args[2], context);
    const rightField = term.args[3] ? { index: translateArg(term.args[3], context) } : {};
    const argSplitter = allocateArgNumber(context);
    return [
      TermType.MAP,
      [
        [TermType.EQ_JOIN, [prev, leftField, other], rightField],
        [
          TermType.FUNC,
          [
            [TermType.MAKE_ARRAY, [argSplitter]],
            [
              TermType.FUNCALL,
              [
                mapper,
                [TermType.BRACKET, [[TermType.VAR, [argSplitter]], 'left']],
                [TermType.BRACKET, [[TermType.VAR, [argSplitter]], 'right']],
              ],
            ],
          ],
        ],
      ],
    ];
  },
  join,
  zip: TermType.ZIP,
  union: TermType.UNION,
  map: (prev, term, context) => [TermType.MAP, [prev, translateArg(term.args[0], { ...context, autoCoerce: true })]],
  withFields: TermType.WITH_FIELDS,
  hasFields: TermType.HAS_FIELDS,
  filter: TermType.FILTER,
  orderBy: (prev, term, context) => {
    const field = [
      term.args[1] && translateArg(term.args[1], context) === 'desc' ? TermType.DESC : TermType.ASC,
      [translateArg(term.args[0], context)],
    ];
    if (term.args[2] && translateArg(term.args[2], context) === true) {
      return [TermType.ORDER_BY, [prev, field]];
    } else {
      return [TermType.ORDER_BY, [prev], { index: field }];
    }
  },
  group: (prev, term, context) => {
    const argGroup = allocateArgNumber(context);
    const isMultiField = term.args[0].type === 'array';
    const fieldValues: TermJson[] = isMultiField
      ? term.args[0].value.map((val: internalRuntime.QueryArg) => translateArg(val, context))
      : [translateArg(term.args[0], context)]; // group() field (index)
    const funcValue = translateArg(term.args[1], context); // group() callback
    // check if the 'group' parameter is used
    if (context.referencedArgs.has((<any>funcValue)[1][0][1][1] /* func.makearray.args[1] */)) {
      // Group stream, extract reduction & group, call func, ungroup
      return [
        TermType.BRACKET,
        [
          [
            TermType.UNGROUP,
            [
              [
                TermType.FUNCALL,
                [
                  [
                    TermType.FUNC,
                    [
                      [TermType.MAKE_ARRAY, [argGroup]],
                      [
                        TermType.FUNCALL,
                        [
                          funcValue,
                          [TermType.VAR, [argGroup]], // First arg is stream itself
                          isMultiField
                            ? [
                                TermType.MAKE_ARRAY,
                                fieldValues.map((key) => [
                                  TermType.BRACKET,
                                  [[TermType.NTH, [[TermType.VAR, [argGroup]], 0]], key],
                                ]),
                              ]
                            : [TermType.BRACKET, [[TermType.NTH, [[TermType.VAR, [argGroup]], 0]], fieldValues[0]]], // Second arg is group value
                        ],
                      ],
                    ],
                  ],
                  [TermType.GROUP, [prev, ...fieldValues]], // Group current stream on field
                ],
              ],
            ],
          ],
          'reduction', // Extract result
        ],
      ];
    } else {
      // When not using the group parameter we don't need 2 FUNCCALL
      (<any>funcValue)[1][0][1].splice(1, 1);
      return [
        TermType.BRACKET,
        [
          [
            TermType.UNGROUP,
            [
              [
                TermType.FUNCALL,
                [
                  funcValue,
                  [TermType.GROUP, [prev, ...fieldValues]], // Group current stream on field
                ],
              ],
            ],
          ],
          'reduction', // Extract result
        ],
      ];
    }
  },
  count: TermType.COUNT,
  sum: TermType.SUM,
  avg: TermType.AVG,
  min: TermType.MIN,
  max: TermType.MAX,
  distinct: (prev, term, context) => [
    TermType.DISTINCT,
    [prev],
    term.args.length >= 1 ? { index: translateArg(term.args[0], context) } : {},
  ],
  pluck: TermType.PLUCK,
  without: TermType.WITHOUT,
  slice: (prev, term, context) => [
    TermType.LIMIT,
    [[TermType.SKIP, [prev, translateArg(term.args[0], context)]], translateArg(term.args[1], context)],
  ],
  nth: TermType.NTH,

  insert: TermType.INSERT,
  update: TermType.UPDATE,
  replace: TermType.REPLACE,
  delete: TermType.DELETE,
  get: TermType.GET,
  getAll: (prev, term, context) => {
    return [
      TermType.GET_ALL,
      [prev, ...term.args.slice(1).map((arg) => translateArg(arg, context))],
      { index: translateArg(term.args[0], context) },
    ];
  },
  between: (prev, term, context) => {
    return [
      TermType.BETWEEN,
      [prev, translateArg(term.args[1], context), translateArg(term.args[2], context)],
      { index: translateArg(term.args[0], context) },
    ];
  },

  indexCreate: (prev, term, context) => {
    const args = [prev, translateArg(term.args[0], context)];
    if (term.args.length > 1) {
      const argRow = allocateArgNumber(context);
      args.push([
        TermType.FUNC,
        [
          [TermType.MAKE_ARRAY, [argRow]],
          [
            TermType.MAKE_ARRAY,
            term.args.slice(1).map((arg) => [TermType.BRACKET, [[TermType.IMPLICIT_VAR], translateArg(arg, context)]]),
          ],
        ],
      ]);
    }
    return [TermType.INDEX_CREATE, args];
  },
  indexDrop: TermType.INDEX_DROP,
  indexList: TermType.INDEX_LIST,

  tableCreate: TermType.TABLE_CREATE,
  tableDrop: TermType.TABLE_DROP,
  tableList: TermType.TABLE_LIST,
  table: TermType.TABLE,

  dbCreate: TermType.DB_CREATE,
  dbDrop: TermType.DB_DROP,
  dbList: TermType.DB_LIST,
  db: TermType.DB,

  and: TermType.AND,
  or: TermType.OR,
  not: TermType.NOT,
  during: TermType.DURING,
  inTimezone: TermType.IN_TIMEZONE,
  timezone: TermType.TIMEZONE,
  timeOfDay: TermType.TIME_OF_DAY,
  year: TermType.YEAR,
  month: TermType.MONTH,
  day: TermType.DAY,
  dayOfWeek: TermType.DAY_OF_WEEK,
  dayOfYear: TermType.DAY_OF_YEAR,
  hours: TermType.HOURS,
  minutes: TermType.MINUTES,
  seconds: TermType.SECONDS,
  toEpochTime: TermType.TO_EPOCH_TIME,
  add: TermType.ADD,
  sub: TermType.SUB,
  mul: TermType.MUL,
  div: TermType.DIV,
  mod: TermType.MOD,
  bitAnd: TermType.BIT_AND,
  bitOr: TermType.BIT_OR,
  bitXor: TermType.BIT_XOR,
  bitNot: TermType.BIT_NOT,
  bitLShift: TermType.BIT_SAL,
  bitRShift: TermType.BIT_SAR,
  round: TermType.ROUND,
  ceil: TermType.CEIL,
  floor: TermType.FLOOR,
  eq: TermType.EQ,
  ne: TermType.NE,
  gt: TermType.GT,
  ge: TermType.GE,
  lt: TermType.LT,
  le: TermType.LE,
  split: TermType.SPLIT,
  upcase: TermType.UPCASE,
  downcase: TermType.DOWNCASE,
  match: TermType.MATCH,
  includes: TermType.CONTAINS,
  isEmpty: TermType.IS_EMPTY,
  keys: TermType.KEYS,
  values: TermType.VALUES,
  merge: (prev, term, context) => [
    TermType.MERGE,
    [prev, translateArg(term.args[0], { ...context, autoCoerce: true })],
  ],
  expr: (prev, term, context) => translateArg(term.args[0], context),
};

export function translateArg(arg: internalRuntime.QueryArg, context: TranslationContext): TermJson {
  switch (arg.type) {
    case 'value':
      if (arg.value instanceof Date) {
        const timeZone = arg.value.getTimezoneOffset();
        return {
          $reql_type$: 'TIME',
          epoch_time: +arg.value / 1000,
          timezone: `${timeZone < 0 ? '-' : '+'}${Math.abs(timeZone / 60)
            .toFixed(0)
            .padStart(2, '0')}:${(timeZone % 60).toFixed(0).padStart(2, '0')}`,
        };
      }
      return arg.value;
    case 'query':
      if (context.autoCoerce && arg.queryType) {
        let coerceType: string | undefined;
        switch (arg.queryType) {
          case 'stream':
          case 'feed':
          case 'selection':
          case 'table':
            coerceType = 'array';
            break;
        }
        if (coerceType) {
          return [TermType.COERCE_TO, [translateQuery(arg.value, { ...context, autoCoerce: false }), coerceType]];
        }
      }
      return translateQuery(arg.value, context);
    case 'func':
      return [
        TermType.FUNC,
        [
          [TermType.MAKE_ARRAY, arg.args.map((num) => allocateArgNumber(context, num))],
          translateArg(arg.value, context),
        ],
      ];
    case 'array':
      return [TermType.MAKE_ARRAY, arg.value.map((val) => translateArg(val, context))];
    case 'object':
      return Object.entries(arg.value).reduce(
        (prev, [key, val]) => Object.assign(prev, { [key]: translateArg(val, context) }),
        {} as Record<string, TermJson>,
      );
    case 'var': {
      const container = [null, null];
      context.vars.push({ name: arg.value, ref: container as [any] });
      return [TermType.DEFAULT, container];
    }
  }
}

export function translateQuery(query: internalRuntime.QueryBuilderContext, context: TranslationContext): TermJson {
  let prev: TermJson = undefined!;
  for (const term of query) {
    const translator = termTranslationTable[term.id];
    if (typeof translator === 'number') {
      const args = term.args.map((val) => translateArg(val, context));
      if (prev !== undefined) {
        args.unshift(prev);
      }
      prev = [translator, args];
      if (term.opts !== undefined) {
        (<ComplexTermJson>prev)[2] = term.opts;
      }
    } else if (typeof translator === 'function') {
      prev = translator(prev, term, context);
    }
  }
  return prev;
}

export namespace internal {
  export function runQuery(query: internalRuntime.QueryBuilderContext) {
    const dbQuery = translateQuery(query, {
      vars: [],
      argMap: new Map(),
      referencedArgs: new Set(),
    });
    //console.log('runQuery', JSON.stringify(dbQuery));
    return SendQuery(dbQuery).then(async (cursor) => {
      if (!cursor) {
        return;
      }
      const results = await cursor.resolve();
      if (!results) {
        return;
      }
      switch (cursor.getType()) {
        case 'Atom':
          return results[0];
        case 'Cursor':
          return await cursor.toArray();
        default:
          return results;
      }
    });
  }

  const openedCursors = new Map<number, [Cursor, AsyncIterableIterator<any>]>();

  export async function readCursor(reqId: number, query: internalRuntime.QueryBuilderContext) {
    if (!openedCursors.has(reqId)) {
      const dbQuery = translateQuery(query, {
        vars: [],
        argMap: new Map(),
        referencedArgs: new Set(),
      });
      //console.log('readCursor', JSON.stringify(dbQuery));
      const cursor = await SendQuery(dbQuery);
      assert(cursor, 'Query returned no cursor.');
      //console.log(cursor.getType());
      openedCursors.set(reqId, [cursor, cursor[Symbol.asyncIterator]()]);
      cursor.on('close', () => openedCursors.delete(reqId));
      cursor.init();
    }
    const [, iterator] = openedCursors.get(reqId)!;
    return iterator.next();
  }

  export async function closeCursor(reqId: number) {
    if (openedCursors.has(reqId)) {
      const [cursor] = openedCursors.get(reqId)!;
      openedCursors.delete(reqId);
      await cursor.close();
    }
  }
}
