// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CELL_KEY_PREFIX } from './cell.data-model';
import { DataModel, DynamoDBItem, GSI1_INDEX_NAME, GSI2_INDEX_NAME } from '../shared/data-model';
import { KeyBuilder } from '../shared/key-builder';
import { GsiQuery, ItemKey } from '../shared/repository';
import { LifecycleStatus } from '../smithy/source/typescript-ssdk-codegen/src';

/** Composite key prefix for tenant items. */
export const TENANT_KEY_PREFIX = 'TENANT';
/** Fixed sort key — one record per tenant. */
export const TENANT_SORT_KEY = 'META';
/** GSI-2 static partition value shared by all tenant items (§4). */
export const TENANT_GSI2_PARTITION = 'TENANT';

/**
 * The tenant domain record. The tenant carries no source and no scripts —
 * its deployment is defined by its cell's stamped `CellDefinition`
 * (ADR-012); `cellId` is the N:1 placement join, assigned at onboarding and
 * never changed. `adminEmail` is deliberately absent — it is pass-through
 * onboarding input, never persisted (ADR-004).
 */
export interface TenantRecord {
  readonly tenantId: string;
  readonly name: string;
  readonly description?: string;
  /** The cell this tenant is placed in — assigned at onboarding, immutable. */
  readonly cellId: string;
  readonly status: LifecycleStatus;
  readonly statusReason?: string;
  readonly lastBuildId?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * DynamoDB item representation of a {@link TenantRecord}. Tenant items carry
 * both GSI key sets (§4): GSI-1 partitions them by cell for the
 * `ListTenants?cellId=` filter, GSI-2's static partition serves the
 * unfiltered `ListTenants`.
 */
export interface TenantItem extends DynamoDBItem {
  readonly GSI1PK: string;
  readonly GSI1SK: string;
  readonly GSI2PK: string;
  readonly GSI2SK: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description?: string;
  readonly cellId: string;
  readonly status: LifecycleStatus;
  readonly statusReason?: string;
  readonly lastBuildId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Builds the composite base-table key for a tenant. */
export function tenantKey(tenantId: string): ItemKey {
  return { PK: KeyBuilder.build(TENANT_KEY_PREFIX, tenantId), SK: TENANT_SORT_KEY };
}

/** GSI-2 query serving the unfiltered `ListTenants` (§4). */
export function listTenantsQuery(): GsiQuery {
  return {
    indexName: GSI2_INDEX_NAME,
    partitionKey: { name: 'GSI2PK', value: TENANT_GSI2_PARTITION },
  };
}

/** GSI-1 query serving the `ListTenants?cellId=` filter (§4). */
export function listTenantsByCellQuery(cellId: string): GsiQuery {
  return {
    indexName: GSI1_INDEX_NAME,
    partitionKey: { name: 'GSI1PK', value: KeyBuilder.build(CELL_KEY_PREFIX, cellId) },
  };
}

/** Converts between {@link TenantRecord} and its DynamoDB item. */
export class TenantDataModel implements DataModel<TenantRecord, TenantItem> {
  toItem(record: TenantRecord): TenantItem {
    const tenantSortValue = KeyBuilder.build(TENANT_KEY_PREFIX, record.tenantId);
    return {
      ...tenantKey(record.tenantId),
      GSI1PK: KeyBuilder.build(CELL_KEY_PREFIX, record.cellId),
      GSI1SK: tenantSortValue,
      GSI2PK: TENANT_GSI2_PARTITION,
      GSI2SK: tenantSortValue,
      tenantId: record.tenantId,
      name: record.name,
      description: record.description,
      cellId: record.cellId,
      status: record.status,
      statusReason: record.statusReason,
      lastBuildId: record.lastBuildId,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  fromItem(item: TenantItem): TenantRecord {
    return {
      tenantId: item.tenantId,
      name: item.name,
      description: item.description,
      cellId: item.cellId,
      status: item.status,
      statusReason: item.statusReason,
      lastBuildId: item.lastBuildId,
      createdAt: new Date(item.createdAt),
      updatedAt: new Date(item.updatedAt),
    };
  }
}
