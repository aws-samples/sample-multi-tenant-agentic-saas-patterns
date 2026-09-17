// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { LifecycleStatus, SourceType } from '../../src/smithy/source/typescript-ssdk-codegen/src';
import {
  CellDataModel,
  cellKey,
  CellRecord,
  DELETABLE_CELL_STATUSES,
  deleteCellTransition,
  listCellsQuery,
} from '../../src/tenant/cell.data-model';

const dataModel = new CellDataModel();

const record: CellRecord = {
  cellId: '01CELL',
  status: LifecycleStatus.ACTIVE,
  maxTenants: 5,
  tenantCount: 2,
  source: { type: SourceType.GITHUB, location: 'https://example/repository.git' },
  cellScripts: { create: 'cell/create.sh', update: 'cell/update.sh', delete: 'cell/delete.sh' },
  tenantScripts: { create: 't/create.sh', update: 't/update.sh', delete: 't/delete.sh' },
  lastBuildId: undefined,
  statusReason: undefined,
  createdAt: new Date('2026-09-07T00:00:00.000Z'),
  updatedAt: new Date('2026-09-07T00:00:00.000Z'),
};

describe('cellKey', () => {
  test('builds the composite base-table key', () => {
    expect(cellKey('01CELL')).toEqual({ PK: 'CELL#01CELL', SK: 'META' });
  });
});

describe('CellDataModel.toItem', () => {
  const item = dataModel.toItem(record);

  test('maps the base-table key', () => {
    expect(item.PK).toBe('CELL#01CELL');
    expect(item.SK).toBe('META');
  });

  test('stamps GSI-1 attributes: static CELL partition, cell sort (§4)', () => {
    expect(item.GSI1PK).toBe('CELL');
    expect(item.GSI1SK).toBe('CELL#01CELL');
  });

  test('carries NO GSI-2 attributes — cells never appear in the sparse GSI-2 (§4)', () => {
    expect(item).not.toHaveProperty('GSI2PK');
    expect(item).not.toHaveProperty('GSI2SK');
  });

  test('persists the counters and the stamped definition', () => {
    expect(item.maxTenants).toBe(5);
    expect(item.tenantCount).toBe(2);
    expect(item.source).toEqual(record.source);
    expect(item.cellScripts).toEqual(record.cellScripts);
    expect(item.tenantScripts).toEqual(record.tenantScripts);
    expect(item.createdAt).toBe('2026-09-07T00:00:00.000Z');
  });
});

describe('CellDataModel.fromItem', () => {
  test('round-trips a record through the item representation', () => {
    expect(dataModel.fromItem(dataModel.toItem(record))).toEqual(record);
  });

  test('round-trips optional failure/build fields when present', () => {
    const failed: CellRecord = {
      ...record,
      status: LifecycleStatus.UPDATE_FAILED,
      statusReason: 'cell update build failed',
      lastBuildId: 'arn:aws:codebuild:...:build/y',
    };
    expect(dataModel.fromItem(dataModel.toItem(failed))).toEqual(failed);
  });
});

describe('listCellsQuery', () => {
  test('targets the static CELL partition on GSI-1', () => {
    expect(listCellsQuery()).toEqual({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', value: 'CELL' },
    });
  });
});

describe('deleteCellTransition (ADR-014)', () => {
  const transition = deleteCellTransition('2026-09-07T00:00:00.000Z');

  test('accepts ACTIVE and every *_FAILED status — never in-flight', () => {
    expect(DELETABLE_CELL_STATUSES).toEqual([
      LifecycleStatus.ACTIVE,
      LifecycleStatus.CREATE_FAILED,
      LifecycleStatus.UPDATE_FAILED,
      LifecycleStatus.DELETE_FAILED,
    ]);
    expect(transition.fromAnyOf).toEqual(DELETABLE_CELL_STATUSES);
    expect(transition.to).toBe(LifecycleStatus.DELETING);
  });

  test('ANDs the tenantCount = 0 emptiness guard into the same atomic write', () => {
    expect(transition.extraCondition).toEqual({
      conditionExpression: '#tenantCount = :zero',
      expressionAttributeNames: { '#tenantCount': 'tenantCount' },
      expressionAttributeValues: { ':zero': 0 },
    });
  });
});
