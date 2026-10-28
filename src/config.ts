import type { RConnectionOptions, RPoolConnectionOptions } from "rethinkdb-ts";

/**
 * Whose tables an instance serves.
 *
 * - `owned`: the adapter creates a database per schema and a table per declared table, scopes
 *   rows to instances, and keeps its own registry beside them.
 * - `external`: the tables already exist in one database the adapter does not own, named by the
 *   path of `url`. Table and field names are the database's own, read verbatim; registration
 *   reads what exists and never creates, alters or drops anything; rows are read and written,
 *   never the structure. See `docs/external-mode.md`.
 */
export type Mode = "owned" | "external";

/** Whether an external instance answers `@antelopejs/interface-database-catalog`. */
export interface CatalogOptions {
  /**
   * Force the catalog on or off. Unset, it follows the project's development mode: on under
   * `ajs project dev` and `ajs project run`, off under `ajs project start`.
   */
  enabled?: boolean;
}

/**
 * Module configuration, as accepted by `construct`.
 */
export interface Options {
  /** Whose tables this instance serves. Defaults to `owned`. */
  mode?: Mode;
  /**
   * `rethinkdb://user:password@host:port/database`. Required in external mode, with the
   * database as its path; the one secret a project sets through `envOverrides`.
   */
  url?: string;
  /** Direct connection options, for an owned instance. */
  connection?: RConnectionOptions;
  /** Pool options, merged under what `url` gives. */
  pool?: RPoolConnectionOptions;
  /**
   * Time limit of each read of an external instance. RethinkDB has no server-side limit, so the
   * read runs on a connection of its own, closed when the limit passes, which stops it on the
   * server. Refused unless it is a positive safe integer.
   */
  statementTimeoutMs?: number;
  /** The catalog an external instance answers. See {@link CatalogOptions}. */
  catalog?: CatalogOptions;
}

export interface ResolvedOptions {
  mode: Mode;
  /** The connection every query of this instance uses, unless it is direct. */
  pool?: RPoolConnectionOptions;
  connection?: RConnectionOptions;
  /** External mode: the one database every table is read from. */
  database?: string;
  statementTimeoutMs?: number;
  catalog: CatalogOptions;
}

const DEFAULT_MODE: Mode = "owned";
const MODES: readonly Mode[] = ["owned", "external"];
const URL_PROTOCOL = "rethinkdb:";
const DEFAULT_PORT = 28015;
const SMALLEST_POSITIVE_INTEGER = 1;
const POOL_DEFAULTS: RPoolConnectionOptions = {
  pool: true,
  cursor: false,
  silent: true,
  discovery: false,
};

const NOT_CONFIGURED =
  "RethinkDB adapter is not configured: construct() has not run yet";

let resolved: ResolvedOptions | undefined;

function ResolveMode(options?: Options): Mode {
  const mode = options?.mode ?? DEFAULT_MODE;
  if (!MODES.includes(mode)) {
    throw new Error(
      `mode must be one of ${MODES.join(", ")}, received ${String(mode)}`,
    );
  }
  return mode;
}

interface ParsedUrl {
  connection: RConnectionOptions;
  database?: string;
}

function ParseUrl(url: string): ParsedUrl {
  const parsed = new URL(url);
  if (parsed.protocol !== URL_PROTOCOL) {
    throw new Error(
      `url must start with rethinkdb://, received ${parsed.protocol}//`,
    );
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  return {
    connection: {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : DEFAULT_PORT,
      user: decodeURIComponent(parsed.username) || "admin",
      password: decodeURIComponent(parsed.password),
    },
    database: database === "" ? undefined : database,
  };
}

function ExternalDatabase(
  options: Options | undefined,
  parsed?: ParsedUrl,
): string {
  if (!parsed) {
    throw new Error(
      `mode "external" needs a non-empty config.url; set it through the project's envOverrides`,
    );
  }
  if (!parsed.database) {
    throw new Error(
      `mode "external" needs the database as the path of config.url`,
    );
  }
  const poolDatabase = options?.pool?.db;
  if (poolDatabase !== undefined && poolDatabase !== parsed.database) {
    throw new Error(
      `pool.db (${poolDatabase}) disagrees with the database of config.url (${parsed.database})`,
    );
  }
  return parsed.database;
}

function PositiveSafeInteger(
  option: string,
  supplied: number | undefined,
): number | undefined {
  if (supplied === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(supplied) || supplied < SMALLEST_POSITIVE_INTEGER) {
    throw new Error(
      `${option} must be a positive safe integer, received ${supplied}`,
    );
  }
  return supplied;
}

function UrlOf(options?: Options): ParsedUrl | undefined {
  return options?.url !== undefined && options.url.trim() !== ""
    ? ParseUrl(options.url)
    : undefined;
}

export function SetOptions(options?: Options): ResolvedOptions {
  const mode = ResolveMode(options);
  const parsed = UrlOf(options);
  const database =
    mode === "external" ? ExternalDatabase(options, parsed) : undefined;
  const pool = parsed
    ? { ...POOL_DEFAULTS, ...options?.pool, ...parsed.connection }
    : options?.pool;
  if (!pool && !options?.connection) {
    throw new Error("Invalid RethinkDB options: set url, pool or connection");
  }
  resolved = {
    mode,
    pool,
    connection: pool ? undefined : options?.connection,
    database,
    statementTimeoutMs: PositiveSafeInteger(
      "statementTimeoutMs",
      options?.statementTimeoutMs,
    ),
    catalog: options?.catalog ?? {},
  };
  return resolved;
}

export function GetOptions(): ResolvedOptions {
  if (!resolved) {
    throw new Error(NOT_CONFIGURED);
  }
  return resolved;
}

/** Whether the configured instance serves tables it does not own. */
export function IsExternal(): boolean {
  return GetOptions().mode === "external";
}

/** The database an external instance reads every table from. */
export function ExternalDatabaseName(): string {
  const database = GetOptions().database;
  if (!database) {
    throw new Error(
      "ExternalDatabaseName() is only defined on an external instance",
    );
  }
  return database;
}
