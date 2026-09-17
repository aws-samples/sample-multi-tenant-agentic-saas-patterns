// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { LifecycleStatus } from '../../src/smithy/source/typescript-ssdk-codegen/src';
import {
  listTenantsByCellQuery,
  listTenantsQuery,
  TenantDataModel,
  tenantKey,
  TenantRecord,
} from '../../src/tenant/tenant.data-model';

const dataModel = new TenantDataModel();

const record: TenantRecord = {
  tenantId: '01TENANT',
  name: 'acme',
  description: 'a tenant',
  cellId: '01CELL',
  status: LifecycleStatus.CREATING,
  statusReason: undefined,
  lastBuildId: undefined,
  createdAt: new Date('2026-09-07T00:00:00.000Z'),
  updatedAt: new Date('2026-09-07T00:00:00.000Z'),
};

describe('tenantKey', () => {
  test('builds the composite base-table key', () => {
    expect(tenantKey('01TENANT')).toEqual({ PK: 'TENANT#01TENANT', SK: 'META' });
  });
});

describe('TenantDataModel.toItem', () => {
  const item = dataModel.toItem(record);

  test('maps the base-table key', () => {
    expect(item.PK).toBe('TENANT#01TENANT');
    expect(item.SK).toBe('META');
  });

  test('stamps GSI-1 attributes: cell partition, tenant sort (§4)', () => {
    expect(item.GSI1PK).toBe('CELL#01CELL');
    expect(item.GSI1SK).toBe('TENANT#01TENANT');
  });

  test('stamps GSI-2 attributes: static TENANT partition (§4)', () => {
    expect(item.GSI2PK).toBe('TENANT');
    expect(item.GSI2SK).toBe('TENANT#01TENANT');
  });

  test('persists cellId and serialises dates to ISO strings', () => {
    expect(item.cellId).toBe('01CELL');
    expect(item.createdAt).toBe('2026-09-07T00:00:00.000Z');
    expect(item.updatedAt).toBe('2026-09-07T00:00:00.000Z');
  });

  test('carries no source or scripts — the cell owns the definition (ADR-012)', () => {
    expect(item).not.toHaveProperty('resource');
    expect(item).not.toHaveProperty('source');
    expect(item).not.toHaveProperty('cellScripts');
    expect(item).not.toHaveProperty('tenantScripts');
  });
});

describe('TenantDataModel.fromItem', () => {
  test('round-trips a record through the item representation', () => {
    expect(dataModel.fromItem(dataModel.toItem(record))).toEqual(record);
  });

  test('round-trips optional failure/build fields when present', () => {
    const failed: TenantRecord = {
      ...record,
      status: LifecycleStatus.CREATE_FAILED,
      statusReason: 'build failed',
      lastBuildId: 'arn:aws:codebuild:...:build/x',
    };
    expect(dataModel.fromItem(dataModel.toItem(failed))).toEqual(failed);
  });
});

describe('tenant list queries', () => {
  test('listTenantsQuery targets the sparse GSI-2 static partition', () => {
    expect(listTenantsQuery()).toEqual({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', value: 'TENANT' },
    });
  });

  test('listTenantsByCellQuery targets the cell partition on GSI-1', () => {
    expect(listTenantsByCellQuery('01CELL')).toEqual({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', value: 'CELL#01CELL' },
    });
  });
});
