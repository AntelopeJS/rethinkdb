import { TermType } from "rethinkdb-ts/lib/proto/enums";
import type { TermJson } from "rethinkdb-ts/lib/internal-types";
import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";

import { executeBounded, executeTermJson } from "../../connection";
import { ExternalDatabaseName, GetOptions } from "../../config";
import type { ExternalTable, KeyClass } from "./external-descriptor";
import { Func, KeyExpression, KeyValue, Normalized } from "./external-read";
import { FindIndex, GetExternalTable } from "./schema";
import { IsText, IsTextList, type QueryStage } from "./utils";

const ID_FIELD = "_id";
const UNSCOPED_INSTANCES: readonly (string | symbol | undefined)[] = [
  undefined,
  "",
  CROSS_INSTANCE,
];

/** Refuses an instance lifecycle stage, since an external table has no instances to manage. */
export function ExternalInstanceRefusal(stage: string): Error {
  return new Error(
    `The '${stage}' stage manages instances, and an external instance's tables have none: read them through the default instance`,
  );
}

/** Refuses `atomicMutation`, whose contract writes revision fields the client's rows do not have. */
export function ExternalAtomicRefusal(table: string): Error {
  return new Error(
    `The 'atomicMutation' stage is not supported on table ${table}, an external table: its contract writes revision fields the client's rows do not have`,
  );
}

/** A decoded key: constant text parsed as the key's type, a runtime value converted on the server. */
function KeyTerm(key: KeyClass, decoded: TermJson): TermJson {
  return IsText(decoded) ? KeyValue(key, decoded) : KeyExpression(key, decoded);
}

/**
 * The reads of one external table, for `SelectionQuery`: the table of the configured database
 * under its own name, keys converted to the primary key's type, declared indexes resolved to the
 * table's own, and the one normalizing map after the native selection.
 */
export class ExternalReads {
  public readonly table: ExternalTable;

  public constructor(
    schemaId: string,
    tableName: string,
    instanceId: string | typeof CROSS_INSTANCE | undefined,
  ) {
    if (!UNSCOPED_INSTANCES.includes(instanceId)) {
      throw new Error(
        `Table ${tableName} is an external table and has no instances, so instance '${String(instanceId)}' names nothing: read it through the default instance`,
      );
    }
    this.table = GetExternalTable(schemaId, tableName);
  }

  public tableTerm(): TermJson {
    return [
      TermType.TABLE,
      [[TermType.DB, [ExternalDatabaseName()]], this.table.table],
    ];
  }

  public requireKey(): KeyClass {
    if (!this.table.key) {
      throw new Error(
        `Table ${this.table.table} has primary keys of more than one type, so its rows have no _id and cannot be read by key: filter on a field, or getAll by a field name`,
      );
    }
    return this.table.key;
  }

  public refuseFeed(stages: QueryStage[]) {
    if (stages.some((stage) => stage.stage === "changes")) {
      throw new Error(
        `changes() is not supported on table ${this.table.table}, an external table: the adapter reads no feed of the client's database`,
      );
    }
  }

  /**
   * The rows an external write applies to: the native selection itself, or, when stream stages
   * selected them, the rows of the `_id`s those stages answer.
   */
  public async writeTarget(
    selected: TermJson | undefined,
    raw: TermJson,
  ): Promise<TermJson> {
    if (selected === undefined) {
      return raw;
    }
    const read: TermJson = [
      TermType.MAP,
      [selected, Func((row) => [TermType.BRACKET, [row, ID_FIELD]])],
    ];
    const timeoutMs = GetOptions().statementTimeoutMs;
    const ids: unknown =
      timeoutMs === undefined
        ? await executeTermJson(read)
        : await executeBounded(read, timeoutMs);
    const key = this.requireKey();
    return [
      TermType.GET_ALL,
      [
        this.tableTerm(),
        ...(IsTextList(ids) ? ids : []).map((id) => KeyValue(key, id)),
      ],
    ];
  }

  /** Refuses an update computed from the row, which the write-back guard cannot check. */
  public refuseMapper(value: QueryStage | TermJson) {
    if (value instanceof Object && "stage" in value && value.stage === "func") {
      throw new Error(
        `An update of table ${this.table.table} computed from the row is not supported on an external table: pass the new field values`,
      );
    }
  }

  public get(decoded: TermJson): TermJson {
    return [
      TermType.GET,
      [this.tableTerm(), KeyTerm(this.requireKey(), decoded)],
    ];
  }

  private isPrimary(index: string | undefined): boolean {
    return (
      index === undefined ||
      index === ID_FIELD ||
      index === this.table.primaryKey
    );
  }

  /**
   * The table's own index over the fields a declared index names, or the name itself, when it is
   * a multi index exactly when the declared one is.
   */
  private nativeIndex(schemaId: string, index: string): string | undefined {
    const declared = FindIndex(schemaId, this.table.table, index);
    const wanted = (declared?.fields ?? [index]).join(",");
    const multi = declared?.multi ?? false;
    const [name] = Object.entries(this.table.indexes).find(
      ([candidate, fields]) =>
        fields.join(",") === wanted &&
        this.table.multiIndexes.includes(candidate) === multi,
    ) ?? [undefined];
    return name;
  }

  /** A scan matching what the declared index would hold: each array entry of a multi index. */
  private filtered(
    schemaId: string,
    index: string,
    matches: (value: TermJson) => TermJson,
  ): TermJson {
    const declared = FindIndex(schemaId, this.table.table, index);
    const fields = declared?.fields ?? [index];
    const entry = declared?.multi
      ? (value: TermJson): TermJson => [
          TermType.CONTAINS,
          [
            [
              TermType.BRANCH,
              [
                [TermType.EQ, [[TermType.TYPE_OF, [value]], "ARRAY"]],
                value,
                [TermType.MAKE_ARRAY, [value]],
              ],
            ],
            Func(matches),
          ],
        ]
      : matches;
    const value = (row: TermJson): TermJson =>
      fields.length === 1
        ? [TermType.DEFAULT, [[TermType.BRACKET, [row, fields[0]]], null]]
        : [
            TermType.MAKE_ARRAY,
            fields.map((field) => [
              TermType.DEFAULT,
              [[TermType.BRACKET, [row, field]], null],
            ]),
          ];
    return [
      TermType.FILTER,
      [this.tableTerm(), Func((row) => entry(value(row)))],
    ];
  }

  public getAll(
    schemaId: string,
    index: string | undefined,
    keys: TermJson[],
  ): TermJson {
    if (this.isPrimary(index)) {
      const key = this.requireKey();
      return [
        TermType.GET_ALL,
        [this.tableTerm(), ...keys.map((value) => KeyTerm(key, value))],
      ];
    }
    const native = this.nativeIndex(schemaId, String(index));
    if (native) {
      return [TermType.GET_ALL, [this.tableTerm(), ...keys], { index: native }];
    }
    return this.filtered(schemaId, String(index), (value) => [
      TermType.CONTAINS,
      [[TermType.MAKE_ARRAY, keys], value],
    ]);
  }

  public between(
    schemaId: string,
    index: string | undefined,
    low: TermJson,
    high: TermJson,
  ): TermJson {
    if (this.isPrimary(index)) {
      const key = this.requireKey();
      return [
        TermType.BETWEEN,
        [this.tableTerm(), KeyTerm(key, low), KeyTerm(key, high)],
      ];
    }
    const native = this.nativeIndex(schemaId, String(index));
    if (native) {
      return [
        TermType.BETWEEN,
        [this.tableTerm(), low, high],
        { index: native },
      ];
    }
    return this.filtered(schemaId, String(index), (value) => [
      TermType.AND,
      [
        [TermType.GE, [value, low]],
        [TermType.LT, [value, high]],
      ],
    ]);
  }

  /**
   * An `orderBy` that comes first, on the primary key or a native index, sorts the table by that
   * index before normalizing; undefined when it cannot.
   */
  public indexedOrder(
    schemaId: string,
    term: TermJson,
    stage: QueryStage | undefined,
  ): TermJson | undefined {
    const isTable = Array.isArray(term) && term[0] === TermType.TABLE;
    if (!isTable || stage?.stage !== "orderBy") {
      return undefined;
    }
    const index: string = stage.options.index;
    const native = this.isPrimary(index)
      ? this.table.primaryKey
      : this.nativeIndex(schemaId, index);
    if (!native) {
      return undefined;
    }
    const indexValue =
      stage.options.direction === "desc" ? [TermType.DESC, [native]] : native;
    const ordered: TermJson = [
      TermType.ORDER_BY,
      [term],
      { index: indexValue },
    ];
    return this.isPrimary(index)
      ? ordered
      : [
          TermType.UNION,
          [ordered, this.unindexed(term, this.table.indexes[native] ?? [])],
          { interleave: false },
        ];
  }

  /**
   * The rows a secondary index leaves out, those missing an indexed field or holding null there,
   * which an index order would otherwise drop: they follow the ordered rows.
   */
  private unindexed(term: TermJson, fields: string[]): TermJson {
    return [
      TermType.FILTER,
      [
        term,
        Func((row) => [
          TermType.OR,
          fields.map((field) => [
            TermType.EQ,
            [
              [TermType.DEFAULT, [[TermType.BRACKET, [row, field]], null]],
              null,
            ],
          ]),
        ]),
      ],
    ];
  }

  public normalized(term: TermJson, singleElement: boolean): TermJson {
    return Normalized(this.table, term, singleElement);
  }

  /** A lookup into this table: by primary key or a native index on the stored rows, then normalized. */
  public lookup(
    schemaId: string,
    otherKey: string,
    local: TermJson,
  ): TermJson | undefined {
    if (this.isPrimary(otherKey) && this.table.key) {
      return this.normalized(
        [
          TermType.GET_ALL,
          [this.tableTerm(), KeyExpression(this.table.key, local)],
        ],
        false,
      );
    }
    const native = this.nativeIndex(schemaId, otherKey);
    return native
      ? this.normalized(
          [TermType.GET_ALL, [this.tableTerm(), local], { index: native }],
          false,
        )
      : undefined;
  }
}
