// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AmbiguousTransactionError,
  DuplicateTokenError,
  DynamoDBRepository,
  PlacementRaceLostError,
  PlacementTransactions,
  RecordGoneError,
  StaleTransitionError,
} from '../../src/shared/repository';
import { CallerContext } from '../../src/shared/service-config';
import {
  ConflictError,
  InternalServerError,
  ResourceNotFoundError,
} from '../../src/smithy/source/typescript-ssdk-codegen/src';
import { CellItem, CellRecord } from '../../src/tenant/cell.data-model';
import {
  IdempotencyItem,
  IdempotencyRecord,
  createTenantRequestHash,
} from '../../src/tenant/idempotency.data-model';
import { CellDefinition, StampedSourceDefinition, TenantService } from '../../src/tenant/tenant';
import { TenantItem, TenantRecord } from '../../src/tenant/tenant.data-model';

const sfnMock = mockClient(SFNClient);
const context: CallerContext = { operatorId: 'op-1', role: 'operator' };

const TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const CELL_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const OTHER_CELL_ID = '01BX5ZZKBKACTAV9WEVGEMMVS0';

/** The deployment-configured definition — deliberately distinct from the stamped fixtures below. */
const cellDefinition: CellDefinition = {
  source: { type: 'GITHUB', location: 'https://github.com/acme/deployment-config.git' },
  cellScripts: {
    create: 'scripts/sample-cell/create.sh',
    update: 'scripts/sample-cell/update.sh',
    delete: 'scripts/sample-cell/delete.sh',
  },
  tenantScripts: {
    create: 'scripts/sample-tenant/create.sh',
    update: 'scripts/sample-tenant/update.sh',
    delete: 'scripts/sample-tenant/delete.sh',
  },
  maxTenants: 5,
};

/** Stamped values on the cell record — distinct from the deployment config to prove resolution. */
const stampedSource = { type: 'GITHUB' as const, location: 'https://github.com/acme/stamped.git' };
const stampedCellScripts = {
  create: 'stamped/cell/create.sh',
  update: 'stamped/cell/update.sh',
  delete: 'stamped/cell/delete.sh',
};
const stampedTenantScripts = {
  create: 'stamped/tenant/create.sh',
  update: 'stamped/tenant/update.sh',
  delete: 'stamped/tenant/delete.sh',
};

function cellRecord(overrides: Partial<CellRecord> = {}): CellRecord {
  return {
    cellId: CELL_ID,
    status: 'ACTIVE',
    maxTenants: 5,
    tenantCount: 1,
    source: stampedSource,
    cellScripts: stampedCellScripts,
    tenantScripts: stampedTenantScripts,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function tenantRecord(overrides: Partial<TenantRecord> = {}): TenantRecord {
  return {
    tenantId: TENANT_ID,
    name: 'acme',
    cellId: CELL_ID,
    status: 'ACTIVE',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

type TenantRepo = DynamoDBRepository<TenantRecord, TenantItem>;
type CellRepo = DynamoDBRepository<CellRecord, CellItem>;
type IdempotencyRepo = DynamoDBRepository<IdempotencyRecord, IdempotencyItem>;
type Placement = PlacementTransactions<CellRecord, CellItem, TenantRecord, TenantItem>;

interface Mocks {
  tenantRepo?: Partial<TenantRepo>;
  cellRepo?: Partial<CellRepo>;
  idempotencyRepo?: Partial<IdempotencyRepo>;
  placement?: Partial<Placement>;
}

function makeService(mocks: Mocks = {}) {
  return new TenantService({
    tenantRepository: (mocks.tenantRepo ?? {}) as TenantRepo,
    cellRepository: (mocks.cellRepo ?? {}) as CellRepo,
    idempotencyRepository: (mocks.idempotencyRepo ?? {}) as IdempotencyRepo,
    placement: (mocks.placement ?? {}) as Placement,
    cellDefinition,
    stateMachineArn: 'arn:aws:states:eu-central-1:123456789012:stateMachine:provisioning',
    sfnClient: new SFNClient({}),
  });
}

/** One-page candidate scan result. */
function cellPage(...cells: CellRecord[]) {
  return jest.fn().mockResolvedValue({ items: cells, nextToken: undefined });
}

function startedWorkflowInput(call = 0) {
  return JSON.parse(sfnMock.commandCalls(StartExecutionCommand)[call].args[0].input.input!);
}

beforeEach(() => {
  sfnMock.reset();
  sfnMock.on(StartExecutionCommand).resolves({ executionArn: 'arn:...:exec' });
});

describe('CreateTenant placement (§6)', () => {
  test('claims a slot in an existing ACTIVE cell and starts a tenant-only create build', async () => {
    const placeTenantInCell = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: { placeTenantInCell },
    });

    const output = await service.CreateTenant(
      { name: 'acme', adminEmail: 'success@simulator.amazonses.com' },
      context,
    );

    expect(output.tenant?.status).toBe('CREATING');
    expect(output.tenant?.cellId).toBe(CELL_ID);

    // The claim is atomic: cell slot + tenant record in one transaction.
    const claim = placeTenantInCell.mock.calls[0][0];
    expect(claim.cellKey).toEqual({ PK: `CELL#${CELL_ID}`, SK: 'META' });
    expect(claim.tenant.status).toBe('CREATING');
    expect(claim.tenant.cellId).toBe(CELL_ID);
    // adminEmail is workflow input only, never persisted (ADR-004).
    expect(JSON.stringify(claim.tenant)).not.toContain('adminEmail');

    // Existing cell: tenantBuild create only, resolved from the STAMPED definition.
    expect(startedWorkflowInput()).toEqual({
      sourceType: 'GITHUB',
      sourceLocation: 'https://github.com/acme/stamped.git',
      sourceVersion: '', // unpinned stamped source (T5/M10)
      operatorId: 'op-1', // the initiating operator (T10/M12)
      cellId: CELL_ID,
      tenantId: output.tenant?.tenantId,
      tenantBuild: {
        operation: 'create',
        scriptPath: 'stamped/tenant/create.sh',
        failedStatus: 'CREATE_FAILED',
        adminEmail: 'success@simulator.amazonses.com',
      },
    });
  });

  test('filters non-ACTIVE and full cells from the candidate scan client-side', async () => {
    const placeTenantInCell = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      cellRepo: {
        queryIndex: cellPage(
          cellRecord({ cellId: OTHER_CELL_ID, status: 'CREATING' }),
          cellRecord({ cellId: OTHER_CELL_ID, status: 'ACTIVE', tenantCount: 5, maxTenants: 5 }),
          cellRecord(), // the only eligible candidate
        ),
      },
      placement: { placeTenantInCell },
    });

    const output = await service.CreateTenant(
      { name: 'acme', adminEmail: 'success@simulator.amazonses.com' },
      context,
    );

    expect(placeTenantInCell).toHaveBeenCalledTimes(1);
    expect(output.tenant?.cellId).toBe(CELL_ID);
  });

  test('a lost race moves to the next candidate', async () => {
    const placeTenantInCell = jest
      .fn()
      .mockRejectedValueOnce(new PlacementRaceLostError('lost'))
      .mockResolvedValueOnce(undefined);
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord(), cellRecord({ cellId: OTHER_CELL_ID })) },
      placement: { placeTenantInCell },
    });

    const output = await service.CreateTenant(
      { name: 'acme', adminEmail: 'success@simulator.amazonses.com' },
      context,
    );

    expect(placeTenantInCell).toHaveBeenCalledTimes(2);
    expect(placeTenantInCell.mock.calls[1][0].tenant.cellId).toBe(OTHER_CELL_ID);
    expect(output.tenant?.cellId).toBe(OTHER_CELL_ID);
    expect(startedWorkflowInput().cellId).toBe(OTHER_CELL_ID);
  });

  test('exhausting the 5-attempt budget falls through to new-cell creation, not an error', async () => {
    const candidates = Array.from({ length: 7 }, (_, i) =>
      cellRecord({ cellId: `01BX5ZZKBKACTAV9WEVGEMMV${(i + 10).toString(36).toUpperCase()}` }),
    );
    const placeTenantInCell = jest.fn().mockRejectedValue(new PlacementRaceLostError('lost'));
    const createCellWithTenant = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      cellRepo: { queryIndex: cellPage(...candidates) },
      placement: { placeTenantInCell, createCellWithTenant },
    });

    const output = await service.CreateTenant(
      { name: 'acme', adminEmail: 'success@simulator.amazonses.com' },
      context,
    );

    // At most 5 claim attempts (§6) even though 7 candidates exist.
    expect(placeTenantInCell).toHaveBeenCalledTimes(5);
    expect(createCellWithTenant).toHaveBeenCalledTimes(1);
    expect(output.tenant?.status).toBe('CREATING');
  });

  test('no eligible candidate creates a new cell stamped from the deployment config', async () => {
    const createCellWithTenant = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithTenant },
    });

    const output = await service.CreateTenant(
      { name: 'acme', description: 'first', adminEmail: 'success@simulator.amazonses.com' },
      context,
    );

    const { cell, tenant } = createCellWithTenant.mock.calls[0][0];
    // New cell: CREATING, slot pre-claimed, definition stamped from config.
    expect(cell).toMatchObject({
      status: 'CREATING',
      tenantCount: 1,
      maxTenants: 5,
      source: cellDefinition.source,
      cellScripts: cellDefinition.cellScripts,
      tenantScripts: cellDefinition.tenantScripts,
    });
    expect(tenant.status).toBe('CREATING');
    expect(tenant.cellId).toBe(cell.cellId);
    expect(output.tenant?.cellId).toBe(cell.cellId);

    // New cell: cell create build precedes the tenant create build.
    expect(startedWorkflowInput()).toEqual({
      sourceType: 'GITHUB',
      sourceLocation: 'https://github.com/acme/deployment-config.git',
      sourceVersion: '',
      operatorId: 'op-1',
      cellId: cell.cellId,
      cellBuild: {
        operation: 'create',
        scriptPath: 'scripts/sample-cell/create.sh',
        failedStatus: 'CREATE_FAILED',
      },
      tenantId: tenant.tenantId,
      tenantBuild: {
        operation: 'create',
        scriptPath: 'scripts/sample-tenant/create.sh',
        failedStatus: 'CREATE_FAILED',
        adminEmail: 'success@simulator.amazonses.com',
      },
    });
  });

  test('an ambiguous claim outcome fails with 500 and never retargets', async () => {
    const placeTenantInCell = jest
      .fn()
      .mockRejectedValue(new AmbiguousTransactionError('unknown outcome'));
    const createCellWithTenant = jest.fn();
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord(), cellRecord({ cellId: OTHER_CELL_ID })) },
      placement: { placeTenantInCell, createCellWithTenant },
    });

    await expect(
      service.CreateTenant({ name: 'acme', adminEmail: 'success@simulator.amazonses.com' }, context),
    ).rejects.toBeInstanceOf(InternalServerError);

    // No second candidate, no new-cell fall-through, no workflow start.
    expect(placeTenantInCell).toHaveBeenCalledTimes(1);
    expect(createCellWithTenant).not.toHaveBeenCalled();
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('an ambiguous new-cell transaction fails with 500', async () => {
    const service = makeService({
      cellRepo: { queryIndex: cellPage() },
      placement: {
        createCellWithTenant: jest
          .fn()
          .mockRejectedValue(new AmbiguousTransactionError('unknown outcome')),
      },
    });

    await expect(
      service.CreateTenant({ name: 'acme', adminEmail: 'success@simulator.amazonses.com' }, context),
    ).rejects.toBeInstanceOf(InternalServerError);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });
});

describe('CreateTenant compensation (§6)', () => {
  test('existing-cell placement: a rejected start compensates with a single tenant CAS', async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error('Step Functions unavailable'));
    const transitionStatus = jest.fn().mockResolvedValue(tenantRecord({ status: 'CREATE_FAILED' }));
    const failCreatingCellAndTenant = jest.fn();
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      tenantRepo: { transitionStatus },
      placement: { placeTenantInCell: jest.fn().mockResolvedValue(undefined), failCreatingCellAndTenant },
    });

    await expect(
      service.CreateTenant({ name: 'acme', adminEmail: 'success@simulator.amazonses.com' }, context),
    ).rejects.toThrow('Step Functions unavailable');

    expect(transitionStatus).toHaveBeenCalledTimes(1);
    expect(transitionStatus.mock.calls[0][1]).toMatchObject({
      fromAnyOf: ['CREATING'],
      to: 'CREATE_FAILED',
      setFields: { statusReason: expect.stringContaining('Failed to start provisioning workflow') },
    });
    // The paired shape is only for new-cell placement.
    expect(failCreatingCellAndTenant).not.toHaveBeenCalled();
  });

  test('new-cell placement: a rejected start compensates BOTH records with the paired transaction', async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error('start rejected'));
    const failCreatingCellAndTenant = jest.fn().mockResolvedValue(undefined);
    const transitionStatus = jest.fn();
    const service = makeService({
      cellRepo: { queryIndex: cellPage() },
      tenantRepo: { transitionStatus },
      placement: {
        createCellWithTenant: jest.fn().mockResolvedValue(undefined),
        failCreatingCellAndTenant,
      },
    });

    await expect(
      service.CreateTenant({ name: 'acme', adminEmail: 'success@simulator.amazonses.com' }, context),
    ).rejects.toThrow('start rejected');

    expect(failCreatingCellAndTenant).toHaveBeenCalledTimes(1);
    const compensation = failCreatingCellAndTenant.mock.calls[0][0];
    expect(compensation.cellKey.PK).toMatch(/^CELL#/);
    expect(compensation.tenantKey.PK).toMatch(/^TENANT#/);
    expect(compensation.statusReason).toContain('Failed to start provisioning workflow');
    // Never the single-CAS shape for a new cell.
    expect(transitionStatus).not.toHaveBeenCalled();
  });
});

describe('GetTenant', () => {
  test('returns the tenant including its placement', async () => {
    const service = makeService({
      tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord()) },
    });
    const output = await service.GetTenant({ tenantId: TENANT_ID }, context);
    expect(output.tenant?.cellId).toBe(CELL_ID);
  });

  test('throws the modelled 404 for a missing tenant', async () => {
    const service = makeService({ tenantRepo: { get: jest.fn().mockResolvedValue(undefined) } });
    await expect(service.GetTenant({ tenantId: TENANT_ID }, context)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });
});

describe('UpdateTenant', () => {
  test('updates only metadata fields via the existence-guarded write, no workflow', async () => {
    const updateExisting = jest.fn().mockResolvedValue(tenantRecord({ description: 'new desc' }));
    const service = makeService({ tenantRepo: { updateExisting } });

    const output = await service.UpdateTenant(
      { tenantId: TENANT_ID, description: 'new desc' },
      context,
    );

    expect(output.tenant?.description).toBe('new desc');
    const updateRequest = updateExisting.mock.calls[0][1];
    expect(updateRequest.updateExpression).toContain('#description = :description');
    expect(updateRequest.updateExpression).not.toContain('status');
    expect(updateRequest.updateExpression).not.toContain('lastBuildId');
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('maps a concurrent-delete condition failure to 404, not 500 (§7)', async () => {
    const service = makeService({
      tenantRepo: {
        updateExisting: jest.fn().mockRejectedValue(new RecordGoneError('gone')),
      },
    });
    await expect(
      service.UpdateTenant({ tenantId: TENANT_ID, name: 'renamed' }, context),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

describe('DeleteTenant', () => {
  test.each(['CREATING', 'UPDATING', 'DELETING'] as const)(
    'rejects with 409 while in-flight (%s)',
    async (status) => {
      const service = makeService({
        tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord({ status })) },
      });
      await expect(service.DeleteTenant({ tenantId: TENANT_ID }, context)).rejects.toBeInstanceOf(
        ConflictError,
      );
    },
  );

  test.each(['ACTIVE', 'CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'] as const)(
    'transitions on the accepted set and starts the tenant delete build from %s',
    async (status) => {
      const transitionStatus = jest.fn().mockResolvedValue(tenantRecord({ status: 'DELETING' }));
      const service = makeService({
        tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord({ status })), transitionStatus },
        cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
      });

      const output = await service.DeleteTenant({ tenantId: TENANT_ID }, context);

      expect(output.tenant?.status).toBe('DELETING');
      expect(transitionStatus.mock.calls[0][1]).toMatchObject({
        fromAnyOf: ['ACTIVE', 'CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'],
        to: 'DELETING',
      });
      expect(startedWorkflowInput()).toEqual({
        sourceType: 'GITHUB',
        sourceLocation: 'https://github.com/acme/stamped.git',
        sourceVersion: '',
        operatorId: 'op-1',
        cellId: CELL_ID,
        tenantId: TENANT_ID,
        tenantBuild: {
          operation: 'delete',
          scriptPath: 'stamped/tenant/delete.sh',
          failedStatus: 'DELETE_FAILED',
          adminEmail: '',
        },
      });
    },
  );

  test('is allowed regardless of cell status — cleanup must always be reachable (§5)', async () => {
    const transitionStatus = jest.fn().mockResolvedValue(tenantRecord({ status: 'DELETING' }));
    const service = makeService({
      tenantRepo: {
        get: jest.fn().mockResolvedValue(tenantRecord({ status: 'CREATE_FAILED' })),
        transitionStatus,
      },
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord({ status: 'CREATE_FAILED' })) },
    });

    const output = await service.DeleteTenant({ tenantId: TENANT_ID }, context);
    expect(output.tenant?.status).toBe('DELETING');
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(1);
  });

  test('compensates a rejected workflow start DELETING → DELETE_FAILED', async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error('start rejected'));
    const transitionStatus = jest
      .fn()
      .mockResolvedValueOnce(tenantRecord({ status: 'DELETING' }))
      .mockResolvedValueOnce(tenantRecord({ status: 'DELETE_FAILED' }));
    const service = makeService({
      tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord()), transitionStatus },
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
    });

    await expect(service.DeleteTenant({ tenantId: TENANT_ID }, context)).rejects.toThrow(
      'start rejected',
    );

    expect(transitionStatus.mock.calls[1][1]).toMatchObject({
      fromAnyOf: ['DELETING'],
      to: 'DELETE_FAILED',
    });
  });

  test('maps a stale transition to 409', async () => {
    const service = makeService({
      tenantRepo: {
        get: jest.fn().mockResolvedValue(tenantRecord()),
        transitionStatus: jest.fn().mockRejectedValue(new StaleTransitionError('raced')),
      },
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
    });
    await expect(service.DeleteTenant({ tenantId: TENANT_ID }, context)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});

describe('ListTenants', () => {
  test('unfiltered listing queries the static GSI-2 partition', async () => {
    const queryIndex = jest
      .fn()
      .mockResolvedValue({ items: [tenantRecord()], nextToken: 'token-1' });
    const service = makeService({ tenantRepo: { queryIndex } });

    const output = await service.ListTenants({ maxResults: 10, nextToken: 'token-0' }, context);

    expect(queryIndex).toHaveBeenCalledWith(
      { indexName: 'GSI2', partitionKey: { name: 'GSI2PK', value: 'TENANT' } },
      10,
      'token-0',
    );
    expect(output.tenants).toHaveLength(1);
    expect(output.nextToken).toBe('token-1');
  });

  test('?cellId= filters via the tenant items GSI-1 partition', async () => {
    const queryIndex = jest.fn().mockResolvedValue({ items: [tenantRecord()], nextToken: undefined });
    const service = makeService({ tenantRepo: { queryIndex } });

    await service.ListTenants({ cellId: CELL_ID }, context);

    expect(queryIndex).toHaveBeenCalledWith(
      { indexName: 'GSI1', partitionKey: { name: 'GSI1PK', value: `CELL#${CELL_ID}` } },
      undefined,
      undefined,
    );
  });

  test('an unknown cellId yields an empty page, not a 404 (§5)', async () => {
    const service = makeService({
      tenantRepo: { queryIndex: jest.fn().mockResolvedValue({ items: [], nextToken: undefined }) },
    });
    const output = await service.ListTenants({ cellId: OTHER_CELL_ID }, context);
    expect(output.tenants).toEqual([]);
  });
});

describe('GetResource', () => {
  test('resolves source and scripts from the cell record, state from the tenant', async () => {
    const service = makeService({
      tenantRepo: {
        get: jest.fn().mockResolvedValue(tenantRecord({ lastBuildId: 'arn:build/1' })),
      },
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
    });

    const output = await service.GetResource({ tenantId: TENANT_ID }, context);

    expect(output.source).toEqual(stampedSource);
    expect(output.scripts).toEqual(stampedTenantScripts);
    expect(output.status).toBe('ACTIVE');
    expect(output.lastBuildId).toBe('arn:build/1');
    expect(output.cellId).toBe(CELL_ID);
  });

  test('throws the modelled 404 for a missing tenant', async () => {
    const service = makeService({ tenantRepo: { get: jest.fn().mockResolvedValue(undefined) } });
    await expect(service.GetResource({ tenantId: TENANT_ID }, context)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  test('a tenant referencing a missing cell is an invariant violation (500)', async () => {
    const service = makeService({
      tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord()) },
      cellRepo: { get: jest.fn().mockResolvedValue(undefined) },
    });
    await expect(service.GetResource({ tenantId: TENANT_ID }, context)).rejects.toBeInstanceOf(
      InternalServerError,
    );
  });
});

describe('UpdateResource', () => {
  test.each(['CREATING', 'UPDATING', 'DELETING', 'CREATE_FAILED', 'DELETE_FAILED'] as const)(
    'rejects with 409 when the tenant is %s',
    async (status) => {
      const service = makeService({
        tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord({ status })) },
      });
      await expect(service.UpdateResource({ tenantId: TENANT_ID }, context)).rejects.toBeInstanceOf(
        ConflictError,
      );
    },
  );

  test.each(['CREATING', 'UPDATING', 'DELETING', 'CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'] as const)(
    'rejects with 409 when the cell is %s (cross-entity guard, §5)',
    async (cellStatus) => {
      const transitionStatus = jest.fn();
      const service = makeService({
        tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord()), transitionStatus },
        cellRepo: { get: jest.fn().mockResolvedValue(cellRecord({ status: cellStatus })) },
      });
      await expect(service.UpdateResource({ tenantId: TENANT_ID }, context)).rejects.toBeInstanceOf(
        ConflictError,
      );
      // Guarded before any transition — no state was touched.
      expect(transitionStatus).not.toHaveBeenCalled();
    },
  );

  test.each(['ACTIVE', 'UPDATE_FAILED'] as const)(
    'transitions and starts the tenant update build from %s when the cell is ACTIVE',
    async (status) => {
      const transitionStatus = jest.fn().mockResolvedValue(tenantRecord({ status: 'UPDATING' }));
      const service = makeService({
        tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord({ status })), transitionStatus },
        cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
      });

      const output = await service.UpdateResource({ tenantId: TENANT_ID }, context);

      expect(output.tenant?.status).toBe('UPDATING');
      expect(transitionStatus.mock.calls[0][1]).toMatchObject({
        fromAnyOf: ['ACTIVE', 'UPDATE_FAILED'],
        to: 'UPDATING',
      });
      expect(startedWorkflowInput()).toMatchObject({
        cellId: CELL_ID,
        tenantId: TENANT_ID,
        tenantBuild: {
          operation: 'update',
          scriptPath: 'stamped/tenant/update.sh',
          failedStatus: 'UPDATE_FAILED',
          adminEmail: '',
        },
      });
      expect(startedWorkflowInput().cellBuild).toBeUndefined();
    },
  );

  test('compensates a rejected workflow start UPDATING → UPDATE_FAILED', async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error('start rejected'));
    const transitionStatus = jest
      .fn()
      .mockResolvedValueOnce(tenantRecord({ status: 'UPDATING' }))
      .mockResolvedValueOnce(tenantRecord({ status: 'UPDATE_FAILED' }));
    const service = makeService({
      tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord()), transitionStatus },
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()) },
    });

    await expect(service.UpdateResource({ tenantId: TENANT_ID }, context)).rejects.toThrow(
      'start rejected',
    );

    expect(transitionStatus.mock.calls[1][1]).toMatchObject({
      fromAnyOf: ['UPDATING'],
      to: 'UPDATE_FAILED',
    });
  });
});

describe('GetCell', () => {
  test('returns the full cell record including the stamped definition', async () => {
    const service = makeService({
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord({ tenantCount: 3 })) },
    });
    const output = await service.GetCell({ cellId: CELL_ID }, context);
    expect(output.cell?.tenantCount).toBe(3);
    expect(output.cell?.source).toEqual(stampedSource);
    expect(output.cell?.cellScripts).toEqual(stampedCellScripts);
    expect(output.cell?.tenantScripts).toEqual(stampedTenantScripts);
  });

  test('throws the modelled 404 for a missing cell', async () => {
    const service = makeService({ cellRepo: { get: jest.fn().mockResolvedValue(undefined) } });
    await expect(service.GetCell({ cellId: CELL_ID }, context)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });
});

describe('ListCells', () => {
  test('lists the static GSI-1 partition with pagination pass-through', async () => {
    const queryIndex = jest
      .fn()
      .mockResolvedValue({ items: [cellRecord()], nextToken: 'token-1' });
    const service = makeService({ cellRepo: { queryIndex } });

    const output = await service.ListCells({ maxResults: 20, nextToken: 'token-0' }, context);

    expect(queryIndex).toHaveBeenCalledWith(
      { indexName: 'GSI1', partitionKey: { name: 'GSI1PK', value: 'CELL' } },
      20,
      'token-0',
    );
    expect(output.cells).toHaveLength(1);
    expect(output.nextToken).toBe('token-1');
  });
});

describe('UpdateCell', () => {
  test.each(['CREATING', 'UPDATING', 'DELETING', 'CREATE_FAILED', 'DELETE_FAILED'] as const)(
    'rejects with 409 from %s',
    async (status) => {
      const service = makeService({
        cellRepo: { get: jest.fn().mockResolvedValue(cellRecord({ status })) },
      });
      await expect(service.UpdateCell({ cellId: CELL_ID }, context)).rejects.toBeInstanceOf(
        ConflictError,
      );
    },
  );

  test.each(['ACTIVE', 'UPDATE_FAILED'] as const)(
    'transitions and starts a cell-only update build from %s',
    async (status) => {
      const transitionStatus = jest.fn().mockResolvedValue(cellRecord({ status: 'UPDATING' }));
      const service = makeService({
        cellRepo: { get: jest.fn().mockResolvedValue(cellRecord({ status })), transitionStatus },
      });

      const output = await service.UpdateCell({ cellId: CELL_ID }, context);

      expect(output.cell?.status).toBe('UPDATING');
      expect(transitionStatus.mock.calls[0][1]).toMatchObject({
        fromAnyOf: ['ACTIVE', 'UPDATE_FAILED'],
        to: 'UPDATING',
      });
      expect(startedWorkflowInput()).toEqual({
        sourceType: 'GITHUB',
        sourceLocation: 'https://github.com/acme/stamped.git',
        sourceVersion: '',
        operatorId: 'op-1',
        cellId: CELL_ID,
        cellBuild: {
          operation: 'update',
          scriptPath: 'stamped/cell/update.sh',
          failedStatus: 'UPDATE_FAILED',
        },
      });
    },
  );

  test('compensates a rejected workflow start UPDATING → UPDATE_FAILED', async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error('start rejected'));
    const transitionStatus = jest
      .fn()
      .mockResolvedValueOnce(cellRecord({ status: 'UPDATING' }))
      .mockResolvedValueOnce(cellRecord({ status: 'UPDATE_FAILED' }));
    const service = makeService({
      cellRepo: { get: jest.fn().mockResolvedValue(cellRecord()), transitionStatus },
    });

    await expect(service.UpdateCell({ cellId: CELL_ID }, context)).rejects.toThrow('start rejected');

    expect(transitionStatus.mock.calls[1][1]).toMatchObject({
      fromAnyOf: ['UPDATING'],
      to: 'UPDATE_FAILED',
    });
  });
});

describe('DeleteCell', () => {
  test('sets DELETING via the single atomic emptiness-guarded transition (ADR-014)', async () => {
    const transitionStatus = jest
      .fn()
      .mockResolvedValue(cellRecord({ status: 'DELETING', tenantCount: 0 }));
    const service = makeService({
      cellRepo: {
        get: jest.fn().mockResolvedValue(cellRecord({ tenantCount: 0 })),
        transitionStatus,
      },
    });

    const output = await service.DeleteCell({ cellId: CELL_ID }, context);

    expect(output.cell?.status).toBe('DELETING');
    // The emptiness check and the transition are ONE conditional write.
    const transition = transitionStatus.mock.calls[0][1];
    expect(transition).toMatchObject({
      fromAnyOf: ['ACTIVE', 'CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'],
      to: 'DELETING',
    });
    expect(transition.extraCondition.conditionExpression).toBe('#tenantCount = :zero');
    expect(startedWorkflowInput()).toEqual({
      sourceType: 'GITHUB',
      sourceLocation: 'https://github.com/acme/stamped.git',
      sourceVersion: '',
      operatorId: 'op-1',
      cellId: CELL_ID,
      cellBuild: {
        operation: 'delete',
        scriptPath: 'stamped/cell/delete.sh',
        failedStatus: 'DELETE_FAILED',
      },
    });
  });

  test('condition failure (occupied or in-flight) maps to 409', async () => {
    const service = makeService({
      cellRepo: {
        get: jest.fn().mockResolvedValue(cellRecord({ tenantCount: 2 })),
        transitionStatus: jest.fn().mockRejectedValue(new StaleTransitionError('occupied')),
      },
    });
    await expect(service.DeleteCell({ cellId: CELL_ID }, context)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('throws the modelled 404 for a missing cell', async () => {
    const service = makeService({ cellRepo: { get: jest.fn().mockResolvedValue(undefined) } });
    await expect(service.DeleteCell({ cellId: CELL_ID }, context)).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  test('compensates a rejected workflow start DELETING → DELETE_FAILED', async () => {
    sfnMock.on(StartExecutionCommand).rejects(new Error('start rejected'));
    const transitionStatus = jest
      .fn()
      .mockResolvedValueOnce(cellRecord({ status: 'DELETING', tenantCount: 0 }))
      .mockResolvedValueOnce(cellRecord({ status: 'DELETE_FAILED', tenantCount: 0 }));
    const service = makeService({
      cellRepo: {
        get: jest.fn().mockResolvedValue(cellRecord({ tenantCount: 0 })),
        transitionStatus,
      },
    });

    await expect(service.DeleteCell({ cellId: CELL_ID }, context)).rejects.toThrow('start rejected');

    expect(transitionStatus.mock.calls[1][1]).toMatchObject({
      fromAnyOf: ['DELETING'],
      to: 'DELETE_FAILED',
    });
  });
});

describe('CreateTenant idempotency (ADR-017)', () => {
  const CLIENT_TOKEN = 'retry-token-1';
  const createInput = {
    name: 'acme',
    adminEmail: 'success@simulator.amazonses.com',
    clientToken: CLIENT_TOKEN,
  };
  const requestHash = createTenantRequestHash({
    name: 'acme',
    adminEmail: 'success@simulator.amazonses.com',
  });

  function idempotencyRecord(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
    return {
      clientToken: CLIENT_TOKEN,
      tenantId: TENANT_ID,
      requestHash,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      expiresAt: 1757203200,
      ...overrides,
    };
  }

  test('a clientToken adds the idempotency item to the existing-cell claim', async () => {
    const placeTenantInCell = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: { placeTenantInCell },
    });

    const output = await service.CreateTenant(createInput, context);

    const item = placeTenantInCell.mock.calls[0][0].idempotencyItem;
    expect(item).toMatchObject({
      PK: `IDEMPOTENCY#${CLIENT_TOKEN}`,
      SK: 'META',
      clientToken: CLIENT_TOKEN,
      tenantId: output.tenant?.tenantId,
      requestHash,
    });
    // TTL garbage collection: 24h from creation, epoch seconds.
    expect(item.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 23 * 3600);
  });

  test('a clientToken adds the idempotency item to the new-cell transaction', async () => {
    const createCellWithTenant = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      cellRepo: { queryIndex: cellPage() },
      placement: { createCellWithTenant },
    });

    await service.CreateTenant(createInput, context);

    expect(createCellWithTenant.mock.calls[0][0].idempotencyItem).toMatchObject({
      PK: `IDEMPOTENCY#${CLIENT_TOKEN}`,
      requestHash,
    });
  });

  test('without a clientToken no idempotency item is written (baseline behaviour)', async () => {
    const placeTenantInCell = jest.fn().mockResolvedValue(undefined);
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: { placeTenantInCell },
    });

    await service.CreateTenant(
      { name: 'acme', adminEmail: 'success@simulator.amazonses.com' },
      context,
    );

    expect(placeTenantInCell.mock.calls[0][0].idempotencyItem).toBeUndefined();
  });

  test('a replay with matching parameters returns the original tenant — no duplicate onboard', async () => {
    const existing = tenantRecord({ status: 'CREATING' });
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: {
        placeTenantInCell: jest.fn().mockRejectedValue(new DuplicateTokenError('duplicate')),
      },
      idempotencyRepo: { get: jest.fn().mockResolvedValue(idempotencyRecord()) },
      tenantRepo: { get: jest.fn().mockResolvedValue(existing) },
    });

    const output = await service.CreateTenant(createInput, context);

    // The ORIGINAL tenant, not a new one — and no workflow started.
    expect(output.tenant?.tenantId).toBe(TENANT_ID);
    expect(output.tenant?.status).toBe('CREATING');
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('a replay via the new-cell path also returns the original tenant', async () => {
    const service = makeService({
      cellRepo: { queryIndex: cellPage() }, // no candidates → new-cell path
      placement: {
        createCellWithTenant: jest.fn().mockRejectedValue(new DuplicateTokenError('duplicate')),
      },
      idempotencyRepo: { get: jest.fn().mockResolvedValue(idempotencyRecord()) },
      tenantRepo: { get: jest.fn().mockResolvedValue(tenantRecord()) },
    });

    const output = await service.CreateTenant(createInput, context);
    expect(output.tenant?.tenantId).toBe(TENANT_ID);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  test('token reuse with different parameters is a 409', async () => {
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: {
        placeTenantInCell: jest.fn().mockRejectedValue(new DuplicateTokenError('duplicate')),
      },
      idempotencyRepo: {
        get: jest.fn().mockResolvedValue(idempotencyRecord({ requestHash: 'different' })),
      },
    });

    await expect(service.CreateTenant(createInput, context)).rejects.toBeInstanceOf(ConflictError);
  });

  test('a replay whose tenant was since deleted is a 409, not a silent re-onboard', async () => {
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: {
        placeTenantInCell: jest.fn().mockRejectedValue(new DuplicateTokenError('duplicate')),
      },
      idempotencyRepo: { get: jest.fn().mockResolvedValue(idempotencyRecord()) },
      tenantRepo: { get: jest.fn().mockResolvedValue(undefined) },
    });

    await expect(service.CreateTenant(createInput, context)).rejects.toBeInstanceOf(ConflictError);
  });

  test('a duplicate whose record was TTL-collected mid-flight is a 409', async () => {
    const service = makeService({
      cellRepo: { queryIndex: cellPage(cellRecord()) },
      placement: {
        placeTenantInCell: jest.fn().mockRejectedValue(new DuplicateTokenError('duplicate')),
      },
      idempotencyRepo: { get: jest.fn().mockResolvedValue(undefined) },
    });

    await expect(service.CreateTenant(createInput, context)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('operator propagation and source pinning (M12 / M10)', () => {
  test('a stamped source pin and a different operator flow into the workflow input', async () => {
    const sha = '4f0c9e1b2a3d4c5e6f708192a3b4c5d6e7f80912';
    const pinnedSource: StampedSourceDefinition = { ...stampedSource, sourceVersion: sha };
    const transitionStatus = jest.fn().mockResolvedValue(cellRecord({ status: 'UPDATING' }));
    const service = makeService({
      cellRepo: {
        get: jest.fn().mockResolvedValue(cellRecord({ source: pinnedSource })),
        transitionStatus,
      },
    });

    await service.UpdateCell({ cellId: CELL_ID }, { operatorId: 'op-2', role: 'operator' });

    // M10 (T5): the stamped pin rides the resolved execution input — the
    // workflow forwards it to CodeBuild as the SourceVersion override.
    expect(startedWorkflowInput().sourceVersion).toBe(sha);
    // M12 (T10): the operator is the CALLER's verified sub, per request.
    expect(startedWorkflowInput().operatorId).toBe('op-2');
  });
});
