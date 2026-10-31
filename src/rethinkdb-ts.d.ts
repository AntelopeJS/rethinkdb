export {};

declare module "rethinkdb-ts/lib/types" {
  /** `r.desc` builds a ReQL term. The driver's own typing answers `any`. */
  interface R {
    desc(indexName: RValue<string> | Func<any>): RDatum;
  }

  /** An array's `orderBy` also takes a ReQL term, which the driver's own typing leaves out. */
  interface RDatum<T = any> {
    orderBy(
      ...fields: Array<FieldSelector<T> | RDatum>
    ): T extends Array<infer _Element> ? RDatum<T> : never;
  }

  /** A stream's `orderBy` also takes a ReQL term, as a field or as an index. */
  interface RStream<T = any> {
    orderBy(
      ...fieldOrIndex: Array<
        FieldSelector<T> | RDatum | { index: string | RDatum }
      >
    ): this;
  }
}
