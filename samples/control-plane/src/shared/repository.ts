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
import { DataModel, DynamoDBItem } from './data-model';
import { LifecycleStatus, ValidationException } from '../smithy/source/typescript-ssdk-codegen/src';

/** A composite primary key locating one item. */
export interface ItemKey {
  readonly PK: string;
  readonly SK: string;
}

/** Optional condition applied to a write. */
export interface WriteCondition {
  readonly conditionExpression: string;
  readonly expressionAttributeNames?: Record<string, string>;
  readonly expressionAttributeValues?: Record<string, unknown>;
}

/** Field-level update applied to one item. */
export interface ItemUpdate {
  readonly updateExpression: string;
  readonly expressionAttributeNames?: Record<string, string>;
  readonly expressionAttributeValues: Record<string, unknown>;
  readonly conditionExpression?: string;
}

/**
 * A compare-and-set lifecycle status transition. The condition checks the
 * exact expected status or the operation's accepted status set — this is
 * both the concurrency guard and an existence check (a missing item cannot
 * match any status), per §7 of the architecture.
 */
export interface StatusTransition {
  /** Accepted current status(es) — the compare of the compare-and-set. */
  readonly fromAnyOf: readonly string[];
  /** The status written on success. */
  readonly to: string;
  /** ISO-8601 timestamp written to `updatedAt`. */
  readonly updatedAt: string;
  /**
   * Additional owned fields to set alongside the transition (e.g.
   * `statusReason`, `lastBuildId`). Must not include `status`/`updatedAt`.
   */
  readonly setFields?: Record<string, unknown>;
  /** Owned fields to remove (e.g. clearing `statusReason` on a retry). */
  readonly removeFields?: readonly string[];
  /**
   * Extra condition ANDed with the status check — e.g. the DeleteCell
   * transition's `tenantCount = 0` emptiness guard (ADR-014).
   */
  readonly extraCondition?: WriteCondition;
}

/** A paginated query against a GSI partition. */
export interface GsiQuery {
  /** The index to query (see `GSI1_INDEX_NAME` / `GSI2_INDEX_NAME`). */
  readonly indexName: string;
  /** The index partition key attribute name and value to match. */
  readonly partitionKey: { readonly name: string; readonly value: string };
}

/** One page of a paginated read. */
export interface Page<TSchema> {
  readonly items: TSchema[];
  /** Opaque token for the next page; absent on the last page. */
  readonly nextToken?: string;
}

/** Thrown when a conditional write fails (state conflict or duplicate). */
export class ConditionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConditionFailedError';
  }
}

/**
 * A compare-and-set lifecycle transition found the record in a different
 * status than expected (or missing). The record was concurrently mutated —
 * the service maps this to a 409 `ConflictError` (§7).
 */
export class StaleTransitionError extends ConditionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'StaleTransitionError';
  }
}

/**
 * An existence-guarded write (`attribute_exists(PK)`, ADR-011) found no
 * record — the write lost a race with a concurrent delete. The service maps
 * this to a 404 `ResourceNotFoundError`, not an unmodelled 500 (§7).
 */
export class RecordGoneError extends ConditionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'RecordGoneError';
  }
}

/**
 * A placement claim lost the race for a cell slot: the transaction was
 * cancelled and the cancellation reasons identify the cell status/capacity
 * condition as the (only) failed check. Safe to retry against the next
 * candidate cell (§6 step 2).
 */
export class PlacementRaceLostError extends ConditionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'PlacementRaceLostError';
  }
}

/**
 * A placement transaction was cancelled because the idempotency item's
 * `attribute_not_exists(PK)` condition failed: the caller's `clientToken`
 * was already used by an earlier CreateTenant (ADR-017). The service
 * replays the original outcome instead of onboarding a duplicate.
 */
export class DuplicateTokenError extends ConditionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateTokenError';
  }
}

/**
 * A placement transaction failed for any reason other than a clean
 * lost-race cancellation. The outcome is ambiguous — the request must fail;
 * the same tenant must NEVER be retargeted at another cell (§6 step 2).
 */
export class AmbiguousTransactionError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AmbiguousTransactionError';
  }
}

/** Encodes a DynamoDB `LastEvaluatedKey` as an opaque pagination token. */
export function encodePageToken(lastEvaluatedKey: Record<string, unknown> | undefined): string | undefined {
  if (lastEvaluatedKey === undefined) {
    return undefined;
  }
  return Buffer.from(JSON.stringify(lastEvaluatedKey), 'utf8').toString('base64url');
}

/**
 * Decodes an opaque pagination token back to a DynamoDB `ExclusiveStartKey`.
 * A token the caller supplied that does not decode to a JSON object throws
 * the MODELLED `ValidationException` (on every list operation's errors
 * list), so the SSDK renders a 400 — a garbage token is a client error,
 * never a 500.
 */
export function decodePageToken(token: string | undefined): Record<string, unknown> | undefined {
  if (token === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw invalidPageTokenError();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidPageTokenError();
  }
  return parsed as Record<string, unknown>;
}

/** The modelled 400 for an undecodable or structurally invalid pagination token. */
function invalidPageTokenError(): ValidationException {
  return new ValidationException({
    message: 'Invalid nextToken: supply a token returned by a previous page, or omit it',
  });
}

/**
 * Maps DynamoDB's own `ValidationException` — the only caller-influenced
 * trigger on these static queries is a parseable-but-invalid
 * `ExclusiveStartKey` — to the modelled 400 instead of an unmodelled 500.
 */
function throwIfInvalidStartKey(error: unknown): void {
  if (error instanceof Error && error.name === 'ValidationException') {
    throw invalidPageTokenError();
  }
}

/** Creates the default document client shared by the repository classes. */
function defaultDocumentClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

/** Per-transaction-item cancellation codes, when the error carries them. */
function cancellationCodes(error: unknown): string[] | undefined {
  if (error instanceof Error && error.name === 'TransactionCanceledException') {
    const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
    return reasons?.map((reason) => reason?.Code ?? 'None');
  }
  return undefined;
}

/**
 * The optional CreateTenant idempotency transact item (ADR-017): a `Put`
 * conditional on `attribute_not_exists(PK)`, always appended LAST so its
 * cancellation code has a fixed position for classification.
 */
function idempotencyPut(tableName: string, item: DynamoDBItem | undefined) {
  return item === undefined
    ? []
    : [
      {
        Put: {
          TableName: tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
    ];
}

/**
 * Throws {@link DuplicateTokenError} when a placement transaction was
 * cancelled and the idempotency item's condition (the LAST transact item,
 * only present when the caller supplied a `clientToken`) is among the failed
 * checks (ADR-017).
 */
function throwIfDuplicateToken(codes: string[] | undefined, item: DynamoDBItem | undefined): void {
  if (
    item !== undefined &&
    codes !== undefined &&
    codes[codes.length - 1] === 'ConditionalCheckFailed'
  ) {
    throw new DuplicateTokenError('clientToken was already used by an earlier CreateTenant');
  }
}

/**
 * Generic single-table CRUD repository. Uses a {@link DataModel} for all
 * conversions between domain schemas and DynamoDB items. Carries no caller
 * context — identifiers arrive through the data model at call time.
 */
export class DynamoDBRepository<TSchema, TItem extends DynamoDBItem> {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    private readonly dataModel: DataModel<TSchema, TItem>,
    client?: DynamoDBDocumentClient,
  ) {
    this.client = client ?? defaultDocumentClient();
  }

  /** Reads one item; `undefined` when it does not exist. */
  async get(key: ItemKey): Promise<TSchema | undefined> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: key }),
    );
    return result.Item === undefined ? undefined : this.dataModel.fromItem(result.Item as TItem);
  }

  /**
   * Writes one item, optionally guarded by a condition. Conditional failures
   * (duplicate create, invalid state transition) surface as
   * {@link ConditionFailedError} for the service layer to map to a 409.
   */
  async put(schema: TSchema, condition?: WriteCondition): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: this.dataModel.toItem(schema),
          ConditionExpression: condition?.conditionExpression,
          ExpressionAttributeNames: condition?.expressionAttributeNames,
          ExpressionAttributeValues: condition?.expressionAttributeValues as
            | Record<string, never>
            | undefined,
        }),
      );
    } catch (error) {
      this.throwIfConditionFailed(error, () => new ConditionFailedError('Conditional write failed'));
      throw error;
    }
  }

  /** Atomically updates owned fields and returns the complete post-update item. */
  async update(key: ItemKey, update: ItemUpdate): Promise<TSchema> {
    return this.sendUpdate(
      key,
      update,
      () => new ConditionFailedError('Conditional update failed'),
    );
  }

  /**
   * Field-ownership metadata/failure write (ADR-011): updates only the
   * caller-owned fields, guarded by `attribute_exists(PK)` so the write can
   * never recreate a concurrently deleted record as a ghost. Condition
   * failure means the record is gone — thrown as {@link RecordGoneError}
   * for the service to map to a 404 (§7).
   */
  async updateExisting(key: ItemKey, update: ItemUpdate): Promise<TSchema> {
    const guarded: ItemUpdate = {
      ...update,
      conditionExpression:
        update.conditionExpression === undefined
          ? 'attribute_exists(PK)'
          : `attribute_exists(PK) AND (${update.conditionExpression})`,
    };
    return this.sendUpdate(
      key,
      guarded,
      () => new RecordGoneError('Record no longer exists — lost to a concurrent delete'),
    );
  }

  /**
   * Compare-and-set lifecycle transition (§5/§7): one conditional
   * `UpdateItem` whose condition checks the exact expected status (or the
   * accepted status set) — plus any extra condition, e.g. the DeleteCell
   * `tenantCount = 0` emptiness guard. Condition failure is thrown as
   * {@link StaleTransitionError} for the service to map to a 409.
   */
  async transitionStatus(key: ItemKey, transition: StatusTransition): Promise<TSchema> {
    const names: Record<string, string> = { '#status': 'status', '#updatedAt': 'updatedAt' };
    const values: Record<string, unknown> = {
      ':to': transition.to,
      ':updatedAt': transition.updatedAt,
    };

    const setParts = ['#status = :to', '#updatedAt = :updatedAt'];
    for (const [field, value] of Object.entries(transition.setFields ?? {})) {
      names[`#${field}`] = field;
      values[`:${field}`] = value;
      setParts.push(`#${field} = :${field}`);
    }

    let updateExpression = `SET ${setParts.join(', ')}`;
    if (transition.removeFields !== undefined && transition.removeFields.length > 0) {
      for (const field of transition.removeFields) {
        names[`#${field}`] = field;
      }
      updateExpression += ` REMOVE ${transition.removeFields.map((f) => `#${f}`).join(', ')}`;
    }

    const fromPlaceholders = transition.fromAnyOf.map((status, index) => {
      values[`:from${index}`] = status;
      return `:from${index}`;
    });
    let conditionExpression = `#status IN (${fromPlaceholders.join(', ')})`;
    if (transition.extraCondition !== undefined) {
      conditionExpression += ` AND (${transition.extraCondition.conditionExpression})`;
      Object.assign(names, transition.extraCondition.expressionAttributeNames);
      Object.assign(values, transition.extraCondition.expressionAttributeValues);
    }

    return this.sendUpdate(
      key,
      {
        updateExpression,
        conditionExpression,
        expressionAttributeNames: names,
        expressionAttributeValues: values,
      },
      () =>
        new StaleTransitionError(
          `Status transition to ${transition.to} failed — record missing or not in ${transition.fromAnyOf.join('/')}`,
        ),
    );
  }

  /** Deletes one item, optionally guarded by a condition. */
  async delete(key: ItemKey, condition?: WriteCondition): Promise<void> {
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: key,
          ConditionExpression: condition?.conditionExpression,
          ExpressionAttributeNames: condition?.expressionAttributeNames,
          ExpressionAttributeValues: condition?.expressionAttributeValues as
            | Record<string, never>
            | undefined,
        }),
      );
    } catch (error) {
      this.throwIfConditionFailed(error, () => new ConditionFailedError('Conditional delete failed'));
      throw error;
    }
  }

  /**
   * Reads one page of a GSI partition (§4): `ListCells` and the placement
   * candidate scan use GSI-1's static `CELL` partition, `ListTenants` uses
   * GSI-2's static `TENANT` partition, and `ListTenants?cellId=` uses the
   * tenant items' `CELL#<cellId>` GSI-1 partition. ULID sort keys give
   * creation order. The GSIs are eventually consistent and never
   * authoritative — every claim is a conditional write on the base table.
   */
  async queryIndex(query: GsiQuery, maxResults?: number, nextToken?: string): Promise<Page<TSchema>> {
    let result;
    try {
      result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: query.indexName,
          KeyConditionExpression: '#pk = :pk',
          ExpressionAttributeNames: { '#pk': query.partitionKey.name },
          ExpressionAttributeValues: { ':pk': query.partitionKey.value },
          Limit: maxResults,
          ExclusiveStartKey: decodePageToken(nextToken) as Record<string, never> | undefined,
        }),
      );
    } catch (error) {
      throwIfInvalidStartKey(error);
      throw error;
    }
    return {
      items: (result.Items ?? []).map((item) => this.dataModel.fromItem(item as TItem)),
      nextToken: encodePageToken(result.LastEvaluatedKey),
    };
  }

  private async sendUpdate(
    key: ItemKey,
    update: ItemUpdate,
    onConditionFailed: () => ConditionFailedError,
  ): Promise<TSchema> {
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: key,
          UpdateExpression: update.updateExpression,
          ConditionExpression: update.conditionExpression,
          ExpressionAttributeNames: update.expressionAttributeNames,
          ExpressionAttributeValues: update.expressionAttributeValues as Record<string, never>,
          ReturnValues: 'ALL_NEW',
        }),
      );
      if (result.Attributes === undefined) {
        throw new Error('DynamoDB update returned no attributes');
      }
      return this.dataModel.fromItem(result.Attributes as TItem);
    } catch (error) {
      this.throwIfConditionFailed(error, onConditionFailed);
      throw error;
    }
  }

  private throwIfConditionFailed(error: unknown, create: () => ConditionFailedError): void {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      throw create();
    }
  }
}

/**
 * The placement/compensation `TransactWriteItems` shapes (§6, ADR-013).
 * This class owns the service-side transaction shapes; the workflow-side
 * terminal writes (tenant delete + slot release, cell terminal writes) run
 * inside Step Functions against the same shape contract and are implemented
 * in the workflow definition, not here.
 *
 * @typeParam TCellSchema / TCellItem — the cell record and its item shape
 * @typeParam TTenantSchema / TTenantItem — the tenant record and its item shape
 */
export class PlacementTransactions<
  TCellSchema,
  TCellItem extends DynamoDBItem,
  TTenantSchema,
  TTenantItem extends DynamoDBItem,
> {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    private readonly cellDataModel: DataModel<TCellSchema, TCellItem>,
    private readonly tenantDataModel: DataModel<TTenantSchema, TTenantItem>,
    client?: DynamoDBDocumentClient,
  ) {
    this.client = client ?? defaultDocumentClient();
  }

  /**
   * §6 step 2 — claim a slot in an existing `ACTIVE` cell and persist the
   * tenant, atomically:
   *
   * - `Update` cell: `SET tenantCount = tenantCount + 1`, condition
   *   `status = ACTIVE AND tenantCount < maxTenants`
   * - `Put` tenant (status `CREATING`, `cellId` set), condition
   *   `attribute_not_exists(PK)`
   *
   * The stable `clientRequestToken` gives short-window replay protection for
   * identical automatic retries. When the caller supplied a CreateTenant
   * `clientToken`, the idempotency item joins the transaction as a third
   * `Put` conditional on `attribute_not_exists(PK)` (ADR-017) — a failed
   * idempotency condition throws {@link DuplicateTokenError} (replay the
   * original outcome). Throws {@link PlacementRaceLostError} ONLY when the
   * cancellation reasons identify the cell status/capacity check as the sole
   * failed condition (safe to try the next candidate); every other failure
   * is an {@link AmbiguousTransactionError} — never retarget the same tenant
   * after an ambiguous outcome.
   */
  async placeTenantInCell(params: {
    /** Base-table key of the candidate cell. */
    readonly cellKey: ItemKey;
    /** The fully-formed tenant record (status CREATING, cellId = candidate). */
    readonly tenant: TTenantSchema;
    /** ISO-8601 timestamp stamped onto the cell's `updatedAt`. */
    readonly updatedAt: string;
    /** Stable idempotency token — same value on identical retries. */
    readonly clientRequestToken: string;
    /** CreateTenant idempotency item (ADR-017); absent when no clientToken. */
    readonly idempotencyItem?: DynamoDBItem;
  }): Promise<void> {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: params.cellKey,
                UpdateExpression:
                  'SET #tenantCount = #tenantCount + :one, #updatedAt = :updatedAt',
                ConditionExpression: '#status = :active AND #tenantCount < #maxTenants',
                ExpressionAttributeNames: {
                  '#tenantCount': 'tenantCount',
                  '#maxTenants': 'maxTenants',
                  '#status': 'status',
                  '#updatedAt': 'updatedAt',
                },
                ExpressionAttributeValues: {
                  ':one': 1,
                  ':active': LifecycleStatus.ACTIVE,
                  ':updatedAt': params.updatedAt,
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: this.tenantDataModel.toItem(params.tenant),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            ...idempotencyPut(this.tableName, params.idempotencyItem),
          ],
          ClientRequestToken: params.clientRequestToken,
        }),
      );
    } catch (error) {
      const codes = cancellationCodes(error);
      // A failed idempotency condition (the LAST item, when present) is a
      // replay of an earlier CreateTenant — it wins over every other
      // classification, because replaying the original outcome is correct
      // regardless of what else the cancellation reports (ADR-017).
      throwIfDuplicateToken(codes, params.idempotencyItem);
      // Lost race iff the cell's status/capacity condition is the ONLY
      // failed check. A failed tenant Put (or any other reason) is ambiguous.
      // Accepted: a ULID collision on the tenant Put lands here as a 500 —
      // the client retry mints a fresh ULID; the probability is negligible.
      if (
        codes !== undefined &&
        codes[0] === 'ConditionalCheckFailed' &&
        codes.slice(1).every((code) => code !== 'ConditionalCheckFailed')
      ) {
        throw new PlacementRaceLostError('Lost the placement race for the candidate cell');
      }
      throw new AmbiguousTransactionError('Placement transaction failed ambiguously', error);
    }
  }

  /**
   * §6 step 3 — no candidate claimed: create the new cell record (status
   * `CREATING`, `tenantCount = 1` pre-claimed, definition stamped) together
   * with the tenant, atomically. Both `Put`s are conditional on
   * `attribute_not_exists(PK)` — fresh ULIDs make a collision negligible,
   * but no write in this design is unconditional. When the caller supplied a
   * CreateTenant `clientToken`, the idempotency item joins as a third `Put`
   * (ADR-017) — a failed idempotency condition throws
   * {@link DuplicateTokenError}. Any other failure is ambiguous: fail the
   * request, never retarget.
   */
  async createCellWithTenant(params: {
    /** The new cell record — status CREATING, tenantCount 1, stamped definition. */
    readonly cell: TCellSchema;
    /** The tenant record — status CREATING, cellId = the new cell. */
    readonly tenant: TTenantSchema;
    /** Stable idempotency token — same value on identical retries. */
    readonly clientRequestToken: string;
    /** CreateTenant idempotency item (ADR-017); absent when no clientToken. */
    readonly idempotencyItem?: DynamoDBItem;
  }): Promise<void> {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: this.cellDataModel.toItem(params.cell),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: this.tenantDataModel.toItem(params.tenant),
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            ...idempotencyPut(this.tableName, params.idempotencyItem),
          ],
          ClientRequestToken: params.clientRequestToken,
        }),
      );
    } catch (error) {
      throwIfDuplicateToken(cancellationCodes(error), params.idempotencyItem);
      throw new AmbiguousTransactionError('New-cell placement transaction failed', error);
    }
  }

  /**
   * §6 compensation for a new-cell placement whose `StartExecution` was
   * rejected: one `TransactWriteItems` moves BOTH the tenant and the cell
   * from `CREATING` to `CREATE_FAILED`, so compensation cannot leave only
   * one record recoverable. Each update is conditional on the exact
   * in-flight status (`status = CREATING`), which is also the existence
   * check. (Compensation for placement into an EXISTING cell is a single
   * tenant transition — use `DynamoDBRepository.transitionStatus`.)
   */
  async failCreatingCellAndTenant(params: {
    readonly cellKey: ItemKey;
    readonly tenantKey: ItemKey;
    /** Failure detail written to both records' `statusReason`. */
    readonly statusReason: string;
    /** ISO-8601 timestamp written to both records' `updatedAt`. */
    readonly updatedAt: string;
  }): Promise<void> {
    const compensate = (key: ItemKey) => ({
      Update: {
        TableName: this.tableName,
        Key: key,
        UpdateExpression:
          'SET #status = :failed, #statusReason = :reason, #updatedAt = :updatedAt',
        ConditionExpression: '#status = :creating',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#statusReason': 'statusReason',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':failed': LifecycleStatus.CREATE_FAILED,
          ':creating': LifecycleStatus.CREATING,
          ':reason': params.statusReason,
          ':updatedAt': params.updatedAt,
        },
      },
    });
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [compensate(params.cellKey), compensate(params.tenantKey)],
        }),
      );
    } catch (error) {
      const codes = cancellationCodes(error);
      if (codes !== undefined && codes.some((code) => code === 'ConditionalCheckFailed')) {
        throw new StaleTransitionError(
          'Paired CREATE_FAILED compensation found a record no longer in CREATING',
        );
      }
      throw new AmbiguousTransactionError('Paired compensation transaction failed', error);
    }
  }
}
