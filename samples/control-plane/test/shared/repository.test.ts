// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { DataModel, DynamoDBItem } from '../../src/shared/data-model';
import {
  AmbiguousTransactionError,
  ConditionFailedError,
  DuplicateTokenError,
  DynamoDBRepository,
  PlacementRaceLostError,
  PlacementTransactions,
  RecordGoneError,
  StaleTransitionError,
} from '../../src/shared/repository';
import { ValidationException } from '../../src/smithy/source/typescript-ssdk-codegen/src';

interface TestSchema {
  id: string;
  name: string;
}

interface TestItem extends DynamoDBItem {
  id: string;
  name: string;
}

const dataModel: DataModel<TestSchema, TestItem> = {
  toItem: (s) => ({ PK: `TEST#${s.id}`, SK: 'META', id: s.id, name: s.name }),
  fromItem: (i) => ({ id: i.id, name: i.name }),
};

const ddbMock = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const repo = new DynamoDBRepository<TestSchema, TestItem>('test-table', dataModel, client);

function conditionalCheckFailed(): Error {
  const error = new Error('conditional failed');
  error.name = 'ConditionalCheckFailedException';
  return error;
}

function transactionCanceled(codes: (string | undefined)[]): Error {
  const error = new Error('transaction canceled');
  error.name = 'TransactionCanceledException';
  (error as any).CancellationReasons = codes.map((code) =>
    code === undefined ? {} : { Code: code },
  );
  return error;
}

beforeEach(() => ddbMock.reset());

describe('DynamoDBRepository', () => {
  test('get converts an item through the data model', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { PK: 'TEST#1', SK: 'META', id: '1', name: 'a' } });
    expect(await repo.get({ PK: 'TEST#1', SK: 'META' })).toEqual({ id: '1', name: 'a' });
  });

  test('get returns undefined for a missing item', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect(await repo.get({ PK: 'TEST#1', SK: 'META' })).toBeUndefined();
  });

  test('put writes the converted item', async () => {
    ddbMock.on(PutCommand).resolves({});
    await repo.put({ id: '1', name: 'a' });
    const call = ddbMock.commandCalls(PutCommand)[0];
    expect(call.args[0].input.Item).toEqual({ PK: 'TEST#1', SK: 'META', id: '1', name: 'a' });
  });

  test('put maps ConditionalCheckFailedException to ConditionFailedError', async () => {
    ddbMock.on(PutCommand).rejects(conditionalCheckFailed());
    await expect(
      repo.put({ id: '1', name: 'a' }, { conditionExpression: 'attribute_not_exists(PK)' }),
    ).rejects.toBeInstanceOf(ConditionFailedError);
  });

  test('update changes selected fields and returns the complete updated schema', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { PK: 'TEST#1', SK: 'META', id: '1', name: 'renamed' },
    });

    const result = await repo.update(
      { PK: 'TEST#1', SK: 'META' },
      {
        updateExpression: 'SET #name = :name',
        conditionExpression: 'attribute_exists(PK)',
        expressionAttributeNames: { '#name': 'name' },
        expressionAttributeValues: { ':name': 'renamed' },
      },
    );

    expect(result).toEqual({ id: '1', name: 'renamed' });
    expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input).toMatchObject({
      Key: { PK: 'TEST#1', SK: 'META' },
      UpdateExpression: 'SET #name = :name',
      ConditionExpression: 'attribute_exists(PK)',
      ReturnValues: 'ALL_NEW',
    });
  });

  test('update maps ConditionalCheckFailedException to ConditionFailedError', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailed());
    await expect(
      repo.update(
        { PK: 'TEST#1', SK: 'META' },
        {
          updateExpression: 'SET #name = :name',
          conditionExpression: 'attribute_exists(PK)',
          expressionAttributeNames: { '#name': 'name' },
          expressionAttributeValues: { ':name': 'renamed' },
        },
      ),
    ).rejects.toBeInstanceOf(ConditionFailedError);
  });

  test('delete maps ConditionalCheckFailedException to ConditionFailedError', async () => {
    ddbMock.on(DeleteCommand).rejects(conditionalCheckFailed());
    await expect(
      repo.delete({ PK: 'TEST#1', SK: 'META' }, { conditionExpression: '#s = :v' }),
    ).rejects.toBeInstanceOf(ConditionFailedError);
  });
});

describe('DynamoDBRepository.queryIndex', () => {
  test('queries the GSI partition and pages with an opaque token', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ PK: 'TEST#1', SK: 'META', id: '1', name: 'a' }],
      LastEvaluatedKey: { PK: 'TEST#1', SK: 'META', GSI1PK: 'CELL', GSI1SK: 'CELL#1' },
    });

    const page = await repo.queryIndex(
      { indexName: 'GSI1', partitionKey: { name: 'GSI1PK', value: 'CELL' } },
      10,
    );

    expect(page.items).toEqual([{ id: '1', name: 'a' }]);
    expect(page.nextToken).toBeDefined();
    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({
      TableName: 'test-table',
      IndexName: 'GSI1',
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'GSI1PK' },
      ExpressionAttributeValues: { ':pk': 'CELL' },
      Limit: 10,
    });

    // The token feeds the next query as ExclusiveStartKey
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await repo.queryIndex(
      { indexName: 'GSI1', partitionKey: { name: 'GSI1PK', value: 'CELL' } },
      10,
      page.nextToken,
    );
    expect(ddbMock.commandCalls(QueryCommand)[1].args[0].input.ExclusiveStartKey).toEqual({
      PK: 'TEST#1',
      SK: 'META',
      GSI1PK: 'CELL',
      GSI1SK: 'CELL#1',
    });
  });
});

describe('pagination token validation (malformed nextToken → 400, never 500)', () => {
  const gsiQuery = { indexName: 'GSI1', partitionKey: { name: 'GSI1PK', value: 'CELL' } };

  test('an undecodable nextToken throws the modelled ValidationException', async () => {
    await expect(repo.queryIndex(gsiQuery, 10, '%%%not-a-token%%%')).rejects.toBeInstanceOf(
      ValidationException,
    );
    // Never reached DynamoDB — rejected before the query
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  test('a decodable but structurally invalid token (non-object) throws the modelled ValidationException', async () => {
    const token = Buffer.from(JSON.stringify(42), 'utf8').toString('base64url');
    await expect(repo.queryIndex(gsiQuery, 10, token)).rejects.toBeInstanceOf(ValidationException);
  });

  test('a parseable token DynamoDB rejects as an invalid ExclusiveStartKey maps to the modelled 400', async () => {
    const ddbValidation = new Error('The provided starting key is invalid');
    ddbValidation.name = 'ValidationException';
    ddbMock.on(QueryCommand).rejects(ddbValidation);
    const forged = Buffer.from(JSON.stringify({ bogus: 'key' }), 'utf8').toString('base64url');
    await expect(repo.queryIndex(gsiQuery, 10, forged)).rejects.toBeInstanceOf(ValidationException);
  });

  test('non-ValidationException query errors still propagate unchanged', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('throttled'));
    await expect(repo.queryIndex(gsiQuery, 10)).rejects.toThrow('throttled');
  });
});

describe('DynamoDBRepository.updateExisting', () => {
  test('guards the write with attribute_exists(PK)', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { PK: 'TEST#1', SK: 'META', id: '1', name: 'renamed' },
    });
    await repo.updateExisting(
      { PK: 'TEST#1', SK: 'META' },
      {
        updateExpression: 'SET #name = :name',
        expressionAttributeNames: { '#name': 'name' },
        expressionAttributeValues: { ':name': 'renamed' },
      },
    );
    expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ConditionExpression).toBe(
      'attribute_exists(PK)',
    );
  });

  test('ANDs attribute_exists(PK) with a caller condition', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { PK: 'TEST#1', SK: 'META', id: '1', name: 'renamed' },
    });
    await repo.updateExisting(
      { PK: 'TEST#1', SK: 'META' },
      {
        updateExpression: 'SET #name = :name',
        conditionExpression: '#name = :old',
        expressionAttributeNames: { '#name': 'name' },
        expressionAttributeValues: { ':name': 'renamed', ':old': 'a' },
      },
    );
    expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ConditionExpression).toBe(
      'attribute_exists(PK) AND (#name = :old)',
    );
  });

  test('maps a lost concurrent delete to RecordGoneError (→ 404)', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailed());
    await expect(
      repo.updateExisting(
        { PK: 'TEST#1', SK: 'META' },
        {
          updateExpression: 'SET #name = :name',
          expressionAttributeNames: { '#name': 'name' },
          expressionAttributeValues: { ':name': 'renamed' },
        },
      ),
    ).rejects.toBeInstanceOf(RecordGoneError);
  });
});

describe('DynamoDBRepository.transitionStatus', () => {
  test('builds a compare-and-set on the accepted status set', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { PK: 'TEST#1', SK: 'META', id: '1', name: 'a' },
    });

    await repo.transitionStatus(
      { PK: 'TEST#1', SK: 'META' },
      {
        fromAnyOf: ['ACTIVE', 'UPDATE_FAILED'],
        to: 'UPDATING',
        updatedAt: '2026-09-07T00:00:00.000Z',
      },
    );

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression).toBe('SET #status = :to, #updatedAt = :updatedAt');
    expect(input.ConditionExpression).toBe('#status IN (:from0, :from1)');
    expect(input.ExpressionAttributeNames).toEqual({ '#status': 'status', '#updatedAt': 'updatedAt' });
    expect(input.ExpressionAttributeValues).toEqual({
      ':to': 'UPDATING',
      ':updatedAt': '2026-09-07T00:00:00.000Z',
      ':from0': 'ACTIVE',
      ':from1': 'UPDATE_FAILED',
    });
  });

  test('sets and removes additional owned fields', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { PK: 'TEST#1', SK: 'META', id: '1', name: 'a' },
    });

    await repo.transitionStatus(
      { PK: 'TEST#1', SK: 'META' },
      {
        fromAnyOf: ['CREATING'],
        to: 'ACTIVE',
        updatedAt: '2026-09-07T00:00:00.000Z',
        setFields: { lastBuildId: 'build-1' },
        removeFields: ['statusReason'],
      },
    );

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression).toBe(
      'SET #status = :to, #updatedAt = :updatedAt, #lastBuildId = :lastBuildId REMOVE #statusReason',
    );
    expect(input.ExpressionAttributeValues).toMatchObject({ ':lastBuildId': 'build-1' });
    expect(input.ExpressionAttributeNames).toMatchObject({ '#statusReason': 'statusReason' });
  });

  test('ANDs an extra condition — the atomic DeleteCell emptiness guard', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { PK: 'TEST#1', SK: 'META', id: '1', name: 'a' },
    });

    await repo.transitionStatus(
      { PK: 'TEST#1', SK: 'META' },
      {
        fromAnyOf: ['ACTIVE', 'CREATE_FAILED', 'UPDATE_FAILED', 'DELETE_FAILED'],
        to: 'DELETING',
        updatedAt: '2026-09-07T00:00:00.000Z',
        extraCondition: {
          conditionExpression: '#tenantCount = :zero',
          expressionAttributeNames: { '#tenantCount': 'tenantCount' },
          expressionAttributeValues: { ':zero': 0 },
        },
      },
    );

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ConditionExpression).toBe(
      '#status IN (:from0, :from1, :from2, :from3) AND (#tenantCount = :zero)',
    );
    expect(input.ExpressionAttributeValues).toMatchObject({ ':zero': 0 });
  });

  test('maps a stale transition to StaleTransitionError (→ 409)', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailed());
    await expect(
      repo.transitionStatus(
        { PK: 'TEST#1', SK: 'META' },
        { fromAnyOf: ['ACTIVE'], to: 'DELETING', updatedAt: '2026-09-07T00:00:00.000Z' },
      ),
    ).rejects.toBeInstanceOf(StaleTransitionError);
  });
});

describe('PlacementTransactions', () => {
  const cellDataModel: DataModel<{ cellId: string }, DynamoDBItem & { cellId: string }> = {
    toItem: (c) => ({ PK: `CELL#${c.cellId}`, SK: 'META', cellId: c.cellId }),
    fromItem: (i) => ({ cellId: i.cellId }),
  };
  const tenantDataModel: DataModel<TestSchema, TestItem> = {
    toItem: (t) => ({ PK: `TENANT#${t.id}`, SK: 'META', id: t.id, name: t.name }),
    fromItem: (i) => ({ id: i.id, name: i.name }),
  };
  const transactions = new PlacementTransactions(
    'test-table',
    cellDataModel,
    tenantDataModel,
    client,
  );

  const placement = {
    cellKey: { PK: 'CELL#c1', SK: 'META' },
    tenant: { id: 't1', name: 'acme' },
    updatedAt: '2026-09-07T00:00:00.000Z',
    clientRequestToken: 'token-t1',
  };

  test('placeTenantInCell sends the §6 step-2 transaction shape', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await transactions.placeTenantInCell(placement);

    const input = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    expect(input.ClientRequestToken).toBe('token-t1');
    expect(input.TransactItems).toHaveLength(2);

    const cellUpdate = input.TransactItems![0].Update!;
    expect(cellUpdate.Key).toEqual({ PK: 'CELL#c1', SK: 'META' });
    expect(cellUpdate.UpdateExpression).toBe(
      'SET #tenantCount = #tenantCount + :one, #updatedAt = :updatedAt',
    );
    expect(cellUpdate.ConditionExpression).toBe('#status = :active AND #tenantCount < #maxTenants');
    expect(cellUpdate.ExpressionAttributeValues).toMatchObject({ ':one': 1, ':active': 'ACTIVE' });

    const tenantPut = input.TransactItems![1].Put!;
    expect(tenantPut.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(tenantPut.Item).toEqual({ PK: 'TENANT#t1', SK: 'META', id: 't1', name: 'acme' });
  });

  test('classifies a cell status/capacity cancellation as a lost race', async () => {
    ddbMock.on(TransactWriteCommand).rejects(transactionCanceled(['ConditionalCheckFailed', 'None']));
    await expect(transactions.placeTenantInCell(placement)).rejects.toBeInstanceOf(
      PlacementRaceLostError,
    );
  });

  test('a lost race with an undefined tenant reason code is still a lost race', async () => {
    ddbMock.on(TransactWriteCommand).rejects(transactionCanceled(['ConditionalCheckFailed', undefined]));
    await expect(transactions.placeTenantInCell(placement)).rejects.toBeInstanceOf(
      PlacementRaceLostError,
    );
  });

  test('a failed tenant Put condition is ambiguous — never retarget', async () => {
    ddbMock.on(TransactWriteCommand).rejects(transactionCanceled(['None', 'ConditionalCheckFailed']));
    await expect(transactions.placeTenantInCell(placement)).rejects.toBeInstanceOf(
      AmbiguousTransactionError,
    );
  });

  test('both conditions failing is ambiguous — never retarget', async () => {
    ddbMock
      .on(TransactWriteCommand)
      .rejects(transactionCanceled(['ConditionalCheckFailed', 'ConditionalCheckFailed']));
    await expect(transactions.placeTenantInCell(placement)).rejects.toBeInstanceOf(
      AmbiguousTransactionError,
    );
  });

  test('non-cancellation transaction errors are ambiguous — never retarget', async () => {
    ddbMock.on(TransactWriteCommand).rejects(new Error('network sadness'));
    await expect(transactions.placeTenantInCell(placement)).rejects.toBeInstanceOf(
      AmbiguousTransactionError,
    );
  });

  describe('CreateTenant idempotency (ADR-017)', () => {
    const idempotencyItem = {
      PK: 'IDEMPOTENCY#tok-1',
      SK: 'META',
      clientToken: 'tok-1',
      tenantId: 't1',
      requestHash: 'abc',
      createdAt: '2026-09-07T00:00:00.000Z',
      expiresAt: 1757203200,
    };

    test('the idempotency item joins placeTenantInCell as a third conditional Put', async () => {
      ddbMock.on(TransactWriteCommand).resolves({});
      await transactions.placeTenantInCell({ ...placement, idempotencyItem });

      const input = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
      expect(input.TransactItems).toHaveLength(3);
      const idempotencyPut = input.TransactItems![2].Put!;
      expect(idempotencyPut.Item).toEqual(idempotencyItem);
      expect(idempotencyPut.ConditionExpression).toBe('attribute_not_exists(PK)');
    });

    test('a failed idempotency condition classifies as DuplicateTokenError', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['None', 'None', 'ConditionalCheckFailed']));
      await expect(
        transactions.placeTenantInCell({ ...placement, idempotencyItem }),
      ).rejects.toBeInstanceOf(DuplicateTokenError);
    });

    test('a duplicate token wins over a simultaneous lost race', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['ConditionalCheckFailed', 'None', 'ConditionalCheckFailed']));
      await expect(
        transactions.placeTenantInCell({ ...placement, idempotencyItem }),
      ).rejects.toBeInstanceOf(DuplicateTokenError);
    });

    test('a lost race with a clean idempotency condition is still a lost race', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['ConditionalCheckFailed', 'None', 'None']));
      await expect(
        transactions.placeTenantInCell({ ...placement, idempotencyItem }),
      ).rejects.toBeInstanceOf(PlacementRaceLostError);
    });

    test('without an idempotency item a failed LAST condition is the tenant Put — ambiguous, never a replay', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['None', 'ConditionalCheckFailed']));
      await expect(transactions.placeTenantInCell(placement)).rejects.toBeInstanceOf(
        AmbiguousTransactionError,
      );
    });

    test('the idempotency item joins createCellWithTenant as a third conditional Put', async () => {
      ddbMock.on(TransactWriteCommand).resolves({});
      await transactions.createCellWithTenant({
        cell: { cellId: 'c-new' },
        tenant: { id: 't1', name: 'acme' },
        clientRequestToken: 'token-t1',
        idempotencyItem,
      });

      const input = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
      expect(input.TransactItems).toHaveLength(3);
      expect(input.TransactItems![2].Put!.Item).toEqual(idempotencyItem);
      expect(input.TransactItems![2].Put!.ConditionExpression).toBe('attribute_not_exists(PK)');
    });

    test('createCellWithTenant classifies a failed idempotency condition as DuplicateTokenError', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['None', 'None', 'ConditionalCheckFailed']));
      await expect(
        transactions.createCellWithTenant({
          cell: { cellId: 'c-new' },
          tenant: { id: 't1', name: 'acme' },
          clientRequestToken: 'token-t1',
          idempotencyItem,
        }),
      ).rejects.toBeInstanceOf(DuplicateTokenError);
    });

    test('createCellWithTenant with a clean idempotency condition stays ambiguous', async () => {
      ddbMock
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(['ConditionalCheckFailed', 'None', 'None']));
      await expect(
        transactions.createCellWithTenant({
          cell: { cellId: 'c-new' },
          tenant: { id: 't1', name: 'acme' },
          clientRequestToken: 'token-t1',
          idempotencyItem,
        }),
      ).rejects.toBeInstanceOf(AmbiguousTransactionError);
    });
  });

  test('createCellWithTenant sends the §6 step-3 transaction shape', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await transactions.createCellWithTenant({
      cell: { cellId: 'c-new' },
      tenant: { id: 't1', name: 'acme' },
      clientRequestToken: 'token-t1',
    });

    const input = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    expect(input.ClientRequestToken).toBe('token-t1');
    expect(input.TransactItems).toHaveLength(2);
    const [cellPut, tenantPut] = input.TransactItems!.map((item) => item.Put!);
    expect(cellPut.Item).toEqual({ PK: 'CELL#c-new', SK: 'META', cellId: 'c-new' });
    expect(cellPut.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(tenantPut.Item).toEqual({ PK: 'TENANT#t1', SK: 'META', id: 't1', name: 'acme' });
    expect(tenantPut.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  test('createCellWithTenant cancellation is ambiguous', async () => {
    ddbMock.on(TransactWriteCommand).rejects(transactionCanceled(['ConditionalCheckFailed', 'None']));
    await expect(
      transactions.createCellWithTenant({
        cell: { cellId: 'c-new' },
        tenant: { id: 't1', name: 'acme' },
        clientRequestToken: 'token-t1',
      }),
    ).rejects.toBeInstanceOf(AmbiguousTransactionError);
  });

  test('failCreatingCellAndTenant sends the paired CREATING→CREATE_FAILED compensation', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await transactions.failCreatingCellAndTenant({
      cellKey: { PK: 'CELL#c-new', SK: 'META' },
      tenantKey: { PK: 'TENANT#t1', SK: 'META' },
      statusReason: 'StartExecution rejected',
      updatedAt: '2026-09-07T00:00:00.000Z',
    });

    const input = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    expect(input.TransactItems).toHaveLength(2);
    for (const [index, key] of [
      { PK: 'CELL#c-new', SK: 'META' },
      { PK: 'TENANT#t1', SK: 'META' },
    ].entries()) {
      const update = input.TransactItems![index].Update!;
      expect(update.Key).toEqual(key);
      expect(update.ConditionExpression).toBe('#status = :creating');
      expect(update.UpdateExpression).toBe(
        'SET #status = :failed, #statusReason = :reason, #updatedAt = :updatedAt',
      );
      expect(update.ExpressionAttributeValues).toMatchObject({
        ':failed': 'CREATE_FAILED',
        ':creating': 'CREATING',
        ':reason': 'StartExecution rejected',
      });
    }
  });

  test('failCreatingCellAndTenant maps a condition failure to StaleTransitionError', async () => {
    ddbMock.on(TransactWriteCommand).rejects(transactionCanceled(['None', 'ConditionalCheckFailed']));
    await expect(
      transactions.failCreatingCellAndTenant({
        cellKey: { PK: 'CELL#c-new', SK: 'META' },
        tenantKey: { PK: 'TENANT#t1', SK: 'META' },
        statusReason: 'StartExecution rejected',
        updatedAt: '2026-09-07T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(StaleTransitionError);
  });

  test('failCreatingCellAndTenant maps other failures to AmbiguousTransactionError', async () => {
    ddbMock.on(TransactWriteCommand).rejects(new Error('throttled'));
    await expect(
      transactions.failCreatingCellAndTenant({
        cellKey: { PK: 'CELL#c-new', SK: 'META' },
        tenantKey: { PK: 'TENANT#t1', SK: 'META' },
        statusReason: 'StartExecution rejected',
        updatedAt: '2026-09-07T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(AmbiguousTransactionError);
  });
});
