// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { createHash } from 'node:crypto';
import { DataModel, DynamoDBItem } from '../shared/data-model';
import { KeyBuilder } from '../shared/key-builder';
import { ItemKey } from '../shared/repository';

/** Composite key prefix for idempotency items. */
export const IDEMPOTENCY_KEY_PREFIX = 'IDEMPOTENCY';
/** Fixed sort key — one record per client token. */
export const IDEMPOTENCY_SORT_KEY = 'META';
/**
 * How long a `clientToken` is honoured (ADR-017). The record's `expiresAt`
 * drives DynamoDB TTL garbage collection; because TTL deletion is lazy, a
 * token is honoured for AT LEAST this long — replay handling deliberately
 * ignores `expiresAt` and treats any surviving record as authoritative.
 */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/**
 * The CreateTenant idempotency record (ADR-017): written in the same
 * `TransactWriteItems` as the placement, conditional on
 * `attribute_not_exists(PK)`. A cancelled write on this item marks the
 * request as a replay of an earlier CreateTenant with the same
 * `clientToken`.
 */
export interface IdempotencyRecord {
  /** The client-supplied token — the item's identity. */
  readonly clientToken: string;
  /** The tenant the original request onboarded. */
  readonly tenantId: string;
  /**
   * SHA-256 over the original request parameters. A replay whose hash
   * differs is a token reuse with different input — rejected with the 409.
   */
  readonly requestHash: string;
  readonly createdAt: Date;
  /** Epoch seconds — the DynamoDB TTL attribute. */
  readonly expiresAt: number;
}

/** DynamoDB item representation of an {@link IdempotencyRecord}. */
export interface IdempotencyItem extends DynamoDBItem {
  readonly clientToken: string;
  readonly tenantId: string;
  readonly requestHash: string;
  readonly createdAt: string;
  readonly expiresAt: number;
}

/** Builds the composite base-table key for an idempotency record. */
export function idempotencyKey(clientToken: string): ItemKey {
  return { PK: KeyBuilder.build(IDEMPOTENCY_KEY_PREFIX, clientToken), SK: IDEMPOTENCY_SORT_KEY };
}

/**
 * Canonical hash over the CreateTenant parameters that define the request's
 * identity. Positional array form — key order cannot vary; an absent
 * description hashes as null, distinct from an empty string.
 */
export function createTenantRequestHash(params: {
  readonly name: string;
  readonly description?: string;
  readonly adminEmail: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([params.name, params.description ?? null, params.adminEmail]), 'utf8')
    .digest('hex');
}

/** Converts between {@link IdempotencyRecord} and its DynamoDB item. */
export class IdempotencyDataModel implements DataModel<IdempotencyRecord, IdempotencyItem> {
  toItem(record: IdempotencyRecord): IdempotencyItem {
    return {
      ...idempotencyKey(record.clientToken),
      clientToken: record.clientToken,
      tenantId: record.tenantId,
      requestHash: record.requestHash,
      createdAt: record.createdAt.toISOString(),
      expiresAt: record.expiresAt,
    };
  }

  fromItem(item: IdempotencyItem): IdempotencyRecord {
    return {
      clientToken: item.clientToken,
      tenantId: item.tenantId,
      requestHash: item.requestHash,
      createdAt: new Date(item.createdAt),
      expiresAt: item.expiresAt,
    };
  }
}
