// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  IdempotencyDataModel,
  IdempotencyRecord,
  createTenantRequestHash,
  idempotencyKey,
} from '../../src/tenant/idempotency.data-model';

describe('idempotencyKey', () => {
  test('builds the IDEMPOTENCY#<token> / META composite key', () => {
    expect(idempotencyKey('tok-1')).toEqual({ PK: 'IDEMPOTENCY#tok-1', SK: 'META' });
  });
});

describe('createTenantRequestHash (ADR-017)', () => {
  const base = { name: 'acme', adminEmail: 'success@simulator.amazonses.com' };

  test('is deterministic for identical parameters', () => {
    expect(createTenantRequestHash(base)).toBe(createTenantRequestHash({ ...base }));
  });

  test('differs when any parameter differs', () => {
    const hash = createTenantRequestHash(base);
    expect(createTenantRequestHash({ ...base, name: 'other' })).not.toBe(hash);
    expect(
      createTenantRequestHash({ ...base, adminEmail: 'success+2@simulator.amazonses.com' }),
    ).not.toBe(hash);
    expect(createTenantRequestHash({ ...base, description: 'x' })).not.toBe(hash);
  });

  test('an absent description hashes differently from an empty string', () => {
    expect(createTenantRequestHash(base)).not.toBe(
      createTenantRequestHash({ ...base, description: '' }),
    );
  });
});

describe('IdempotencyDataModel', () => {
  const model = new IdempotencyDataModel();
  const record: IdempotencyRecord = {
    clientToken: 'tok-1',
    tenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    requestHash: 'abc123',
    createdAt: new Date('2026-09-07T12:00:00.000Z'),
    expiresAt: 1757203200,
  };

  test('toItem produces the keyed item with an epoch-seconds TTL attribute', () => {
    expect(model.toItem(record)).toEqual({
      PK: 'IDEMPOTENCY#tok-1',
      SK: 'META',
      clientToken: 'tok-1',
      tenantId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      requestHash: 'abc123',
      createdAt: '2026-09-07T12:00:00.000Z',
      expiresAt: 1757203200,
    });
  });

  test('round-trips through toItem/fromItem', () => {
    expect(model.fromItem(model.toItem(record))).toEqual(record);
  });
});
