// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DataModel, DynamoDBItem, GSI1_INDEX_NAME } from '../shared/data-model';
import { KeyBuilder } from '../shared/key-builder';
import { GsiQuery, ItemKey, StatusTransition, WriteCondition } from '../shared/repository';
import {
  LifecycleStatus,
  ScriptLocations,
  SourceDefinition,
} from '../smithy/source/typescript-ssdk-codegen/src';

/** Composite key prefix for cell items. */
export const CELL_KEY_PREFIX = 'CELL';
/** Fixed sort key — one record per cell. */
export const CELL_SORT_KEY = 'META';
/** GSI-1 static partition value shared by all cell items (§4). */
export const CELL_GSI1_PARTITION = 'CELL';

/**
 * Cell statuses from which `DeleteCell` may transition to `DELETING`
 * (ADR-014): `ACTIVE` and every `*_FAILED` state — never in-flight.
 */
export const DELETABLE_CELL_STATUSES: readonly LifecycleStatus[] = [
  LifecycleStatus.ACTIVE,
  LifecycleStatus.CREATE_FAILED,
  LifecycleStatus.UPDATE_FAILED,
  LifecycleStatus.DELETE_FAILED,
];

/**
 * The cell domain record — a deployment unit holding one shared application
 * deployment plus up to `maxTenants` tenants (ADR-012). The definition
 * (`source`, `cellScripts`, `tenantScripts`, `maxTenants`) is stamped from
 * deployment configuration at creation and immutable for the cell's
 * lifetime. `tenantCount` is the atomic slot counter — the capacity and
 * occupancy guard (ADR-013); only the placement transaction increments it
 * and only the delete workflow's terminal transaction decrements it.
 */
export interface CellRecord {
  readonly cellId: string;
  readonly status: LifecycleStatus;
  /** Stamped capacity — maximum tenants this cell can hold. */
  readonly maxTenants: number;
  /** Atomic slot counter — authoritative occupancy (never the GSI). */
  readonly tenantCount: number;
  /** Stamped build input source. */
  readonly source: SourceDefinition;
  /** Stamped lifecycle scripts for the shared cell deployment. */
  readonly cellScripts: ScriptLocations;
  /** Stamped lifecycle scripts for per-tenant deployments in this cell. */
  readonly tenantScripts: ScriptLocations;
  readonly lastBuildId?: string;
  readonly statusReason?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * DynamoDB item representation of a {@link CellRecord}. Cell items carry
 * GSI-1 attributes only (static `CELL` partition for `ListCells` and the
 * placement candidate scan) — GSI-2 is sparse and cells never appear in it
 * (§4).
 */
export interface CellItem extends DynamoDBItem {
  readonly GSI1PK: string;
  readonly GSI1SK: string;
  readonly cellId: string;
  readonly status: LifecycleStatus;
  readonly maxTenants: number;
  readonly tenantCount: number;
  readonly source: SourceDefinition;
  readonly cellScripts: ScriptLocations;
  readonly tenantScripts: ScriptLocations;
  readonly lastBuildId?: string;
  readonly statusReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Builds the composite base-table key for a cell. */
export function cellKey(cellId: string): ItemKey {
  return { PK: KeyBuilder.build(CELL_KEY_PREFIX, cellId), SK: CELL_SORT_KEY };
}

/**
 * GSI-1 query serving `ListCells` and the placement candidate scan (§4).
 * Eventually consistent — candidates are nominations only; the conditional
 * claim on the base table is the guard (§6).
 */
export function listCellsQuery(): GsiQuery {
  return {
    indexName: GSI1_INDEX_NAME,
    partitionKey: { name: 'GSI1PK', value: CELL_GSI1_PARTITION },
  };
}

/** The DeleteCell emptiness guard — `tenantCount = 0` (ADR-014). */
export const CELL_EMPTY_CONDITION: WriteCondition = {
  conditionExpression: '#tenantCount = :zero',
  expressionAttributeNames: { '#tenantCount': 'tenantCount' },
  expressionAttributeValues: { ':zero': 0 },
};

/**
 * The atomic DeleteCell transition (ADR-014): a single conditional
 * `UpdateItem` whose condition is
 * `status IN {ACTIVE, CREATE_FAILED, UPDATE_FAILED, DELETE_FAILED} AND
 * tenantCount = 0` — the emptiness check and the `DELETING` transition are
 * one atomic write, the counterpart of the placement claim. A read-then-write
 * would let a concurrent placement claim a slot before `DELETING` lands.
 * Condition failure (`StaleTransitionError`) maps to the 409.
 */
export function deleteCellTransition(updatedAt: string): StatusTransition {
  return {
    fromAnyOf: DELETABLE_CELL_STATUSES,
    to: LifecycleStatus.DELETING,
    updatedAt,
    extraCondition: CELL_EMPTY_CONDITION,
  };
}

/** Converts between {@link CellRecord} and its DynamoDB item. */
export class CellDataModel implements DataModel<CellRecord, CellItem> {
  toItem(record: CellRecord): CellItem {
    return {
      ...cellKey(record.cellId),
      GSI1PK: CELL_GSI1_PARTITION,
      GSI1SK: KeyBuilder.build(CELL_KEY_PREFIX, record.cellId),
      cellId: record.cellId,
      status: record.status,
      maxTenants: record.maxTenants,
      tenantCount: record.tenantCount,
      source: record.source,
      cellScripts: record.cellScripts,
      tenantScripts: record.tenantScripts,
      lastBuildId: record.lastBuildId,
      statusReason: record.statusReason,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  fromItem(item: CellItem): CellRecord {
    return {
      cellId: item.cellId,
      status: item.status,
      maxTenants: item.maxTenants,
      tenantCount: item.tenantCount,
      source: item.source,
      cellScripts: item.cellScripts,
      tenantScripts: item.tenantScripts,
      lastBuildId: item.lastBuildId,
      statusReason: item.statusReason,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    };
  }
}
