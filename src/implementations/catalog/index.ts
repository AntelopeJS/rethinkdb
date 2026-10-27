import { GetRuntimeInfo } from "@antelopejs/interface-core/runtime";
import type {
  CatalogInfo,
  Measure,
  ProfileRequest,
  ReferenceCheck,
  ReferenceMatch,
  RelationDescription,
  RelationProfile,
  RelationSummary,
  RowSample,
  SampleRequest,
} from "@antelopejs/interface-database-catalog";

import { ExternalDatabaseName, GetOptions, IsExternal } from "../../config";
import { TableNames } from "../database/external-probe";
import { DescribeTable, ListTable, ReadInfo, Summarize } from "./discovery";
import { Sequentially, Serialized } from "./measures";
import { ProfileTable } from "./profile";
import { CheckTableReference } from "./reference";
import { SampleTableRows } from "./rows";

const OWNED_REFUSAL =
  "the catalog describes a database an external instance was pointed at; this instance owns its tables";
const DEVELOPMENT_REFUSAL =
  "the catalog is a development tool: it answers under ajs project dev or run, or with catalog.enabled";

async function IsEnabled(): Promise<boolean> {
  const configured = GetOptions().catalog.enabled;
  return configured ?? (await GetRuntimeInfo()).dev;
}

/** Refuses every catalog call on an owned instance, and outside development unless enabled. */
async function Guarded<T>(work: () => Promise<T>): Promise<T> {
  if (!IsExternal()) {
    throw new Error(OWNED_REFUSAL);
  }
  if (!(await IsEnabled())) {
    throw new Error(DEVELOPMENT_REFUSAL);
  }
  return Serialized(work);
}

export function Info(): Promise<CatalogInfo> {
  return Guarded(ReadInfo);
}

export function ListRelations(schemas?: string[]): Promise<RelationSummary[]> {
  return Guarded(async () => {
    if (schemas && !schemas.includes(ExternalDatabaseName())) {
      return [];
    }
    const names = (await TableNames()).sort();
    return Sequentially(names, async (name) =>
      Summarize(await ListTable(name)),
    );
  });
}

export function DescribeRelations(
  relations: string[],
): Promise<RelationDescription[]> {
  return Guarded(async () => {
    const prefix = `${ExternalDatabaseName()}.`;
    const names = await TableNames();
    const missing = relations.filter(
      (relation) =>
        !relation.startsWith(prefix) ||
        !names.includes(relation.slice(prefix.length)),
    );
    if (missing.length > 0) {
      throw new Error(
        `No relation ${missing.join(", ")} that the connected account can list`,
      );
    }
    return Sequentially(relations, async (relation) =>
      DescribeTable(await ListTable(relation.slice(prefix.length))),
    );
  });
}

export function Profile(request: ProfileRequest): Promise<RelationProfile> {
  return Guarded(() => ProfileTable(request));
}

export function CheckReference(
  check: ReferenceCheck,
): Promise<Measure<ReferenceMatch>> {
  return Guarded(() => CheckTableReference(check));
}

export function SampleRows(request: SampleRequest): Promise<RowSample> {
  return Guarded(() => SampleTableRows(request));
}
