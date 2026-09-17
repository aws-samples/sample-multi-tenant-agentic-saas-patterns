// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { ulid } from 'ulid';
import {
  CellItem,
  CellRecord,
  cellKey,
  deleteCellTransition,
  listCellsQuery,
} from './cell.data-model';
import {
  IDEMPOTENCY_TTL_SECONDS,
  IdempotencyDataModel,
  IdempotencyItem,
  IdempotencyRecord,
  createTenantRequestHash,
  idempotencyKey,
} from './idempotency.data-model';
import {
  TenantItem,
  TenantRecord,
  listTenantsByCellQuery,
  listTenantsQuery,
  tenantKey,
} from './tenant.data-model';
import {
  DuplicateTokenError,
  DynamoDBRepository,
  PlacementRaceLostError,
  PlacementTransactions,
  RecordGoneError,
  StaleTransitionError,
} from '../shared/repository';
import { CallerContext, ServiceConfig } from '../shared/service-config';
import {
  CellSummary,
  ConflictError,
  CreateTenantServerInput,
  CreateTenantServerOutput,
  DeleteCellServerInput,
  DeleteCellServerOutput,
  DeleteTenantServerInput,
  DeleteTenantServerOutput,
  GetCellServerInput,
  GetCellServerOutput,
  GetResourceServerInput,
  GetResourceServerOutput,
  GetTenantServerInput,
  GetTenantServerOutput,
  InternalServerError,
  LifecycleStatus,
  ListCellsServerInput,
  ListCellsServerOutput,
  ListTenantsServerInput,
  ListTenantsServerOutput,
  ResourceNotFoundError,
  ScriptLocations,
  SourceDefinition,
  TenantServiceService,
  TenantSummary,
  UpdateCellServerInput,
  UpdateCellServerOutput,
  UpdateResourceServerInput,
  UpdateResourceServerOutput,
  UpdateTenantServerInput,
  UpdateTenantServerOutput,
} from '../smithy/source/typescript-ssdk-codegen/src';

/** Provisioning workflow operations (mirrors the lifecycle scripts). */
export type ProvisioningOperation = 'create' | 'update' | 'delete';

type FailedLifecycleStatus = 'CREATE_FAILED' | 'UPDATE_FAILED' | 'DELETE_FAILED';
type InFlightLifecycleStatus = 'CREATING' | 'UPDATING' | 'DELETING';

/** One optional build phase of the workflow input (§7). */
interface BuildPhaseInput {
  readonly operation: ProvisioningOperation;
  readonly scriptPath: string;
  readonly failedStatus: FailedLifecycleStatus;
}

/** The tenant build phase — `adminEmail` is always present (empty string for non-create). */
interface TenantBuildPhaseInput extends BuildPhaseInput {
  readonly adminEmail: string;
}

/**
 * Resolved Step Functions execution input (ADR-011 retained): the service
 * resolves sources, script paths, and failure statuses; the workflow rereads
 * no mutable records. `cellBuild`/`tenantBuild` are each optional — the
 * combination encodes the trigger (§7).
 */
interface ProvisioningWorkflowInput {
  readonly sourceType: string;
  readonly sourceLocation: string;
  /**
   * The stamped supply-chain pin (T5/M10) — always present; the empty
   * string means unpinned. A non-empty value becomes the CodeBuild
   * `SourceVersion` override on every build of this execution.
   */
  readonly sourceVersion: string;
  /**
   * The initiating operator (verified JWT `sub` from the authorizer
   * context) — audit propagation into the application plane (T10/M12).
   * Always present; forwarded to every build as `OPERATOR_ID`.
   */
  readonly operatorId: string;
  readonly cellId: string;
  readonly cellBuild?: BuildPhaseInput;
  readonly tenantId?: string;
  readonly tenantBuild?: TenantBuildPhaseInput;
}

/**
 * The stamped provisioning source: the Smithy-modelled shape plus the
 * optional supply-chain pin (T5/M10). `sourceVersion` is deployment
 * configuration, never an API input — the Smithy contract is unchanged; the
 * pin rides along in the CellDefinition env JSON and the stamped cell
 * record, and maps to the CodeBuild StartBuild `sourceVersion` parameter.
 */
export type StampedSourceDefinition = SourceDefinition & {
  readonly sourceVersion?: string;
};

/**
 * The deployment-configured CellDefinition (§10, ADR-012), stamped onto each
 * new cell record at creation. Supplied to the Lambda as the
 * `CELL_DEFINITION` env JSON (validated at synth time) and parsed once at
 * cold start.
 */
export interface CellDefinition {
  readonly source: StampedSourceDefinition;
  readonly cellScripts: ScriptLocations;
  readonly tenantScripts: ScriptLocations;
  readonly maxTenants: number;
}

/**
 * Parses (and fail-fast validates) the `CELL_DEFINITION` env JSON at cold
 * start. Synthesis already validates the deployment input (§10) — a failure
 * here indicates deployment drift, never a client error.
 */
export function parseCellDefinition(json: string): CellDefinition {
  const parsed = JSON.parse(json) as CellDefinition;
  const missing: string[] = [];
  if (!parsed?.source?.type || !parsed?.source?.location) {
    missing.push('source');
  }
  for (const scriptSet of ['cellScripts', 'tenantScripts'] as const) {
    for (const operation of ['create', 'update', 'delete'] as const) {
      if (!parsed?.[scriptSet]?.[operation]) {
        missing.push(`${scriptSet}.${operation}`);
      }
    }
  }
  if (!Number.isInteger(parsed?.maxTenants) || parsed.maxTenants < 1) {
    missing.push('maxTenants');
  }
  if (missing.length > 0) {
    throw new Error(`Invalid CELL_DEFINITION environment variable — missing/invalid: ${missing.join(', ')}`);
  }
  return parsed;
}

/** Static configuration for the tenant service — built once at cold start. */
export interface TenantServiceConfig extends ServiceConfig {
  /** Repository over tenant items in the control plane table. */
  readonly tenantRepository: DynamoDBRepository<TenantRecord, TenantItem>;
  /** Repository over cell items in the same table. */
  readonly cellRepository: DynamoDBRepository<CellRecord, CellItem>;
  /** Repository over CreateTenant idempotency records (ADR-017). */
  readonly idempotencyRepository: DynamoDBRepository<IdempotencyRecord, IdempotencyItem>;
  /** The placement/compensation transaction shapes (workstream B, §6). */
  readonly placement: PlacementTransactions<CellRecord, CellItem, TenantRecord, TenantItem>;
  /** The deployment-configured CellDefinition, parsed once at cold start (§10). */
  readonly cellDefinition: CellDefinition;
  /** ARN of the provisioning Step Functions state machine. */
  readonly stateMachineArn: string;
  /** Step Functions client (shared across invocations). */
  readonly sfnClient: SFNClient;
}

/** Statuses during which no lifecycle mutation may start. */
const IN_FLIGHT: LifecycleStatus[] = ['CREATING', 'UPDATING', 'DELETING'];

/**
 * Tenant statuses from which DeleteTenant may transition to DELETING (§5):
 * ACTIVE and every *_FAILED state — regardless of cell status, because the
 * delete script is the cleanup path.
 */
const TENANT_DELETABLE_STATUSES: readonly LifecycleStatus[] = [
  'ACTIVE',
  'CREATE_FAILED',
  'UPDATE_FAILED',
  'DELETE_FAILED',
];

/** Statuses from which an update (re-apply) build may start, for both entity types (§5). */
const UPDATABLE_STATUSES: readonly LifecycleStatus[] = ['ACTIVE', 'UPDATE_FAILED'];

/**
 * The placement candidate budget (§6): at most this many claim attempts
 * before falling through to new-cell creation. Keeps CreateTenant inside the
 * synchronous API Gateway window; its miss case over-provisions, never fails
 * an onboard.
 */
const MAX_CLAIM_ATTEMPTS = 5;

/** A best-effort compensation write for a rejected StartExecution (ADR-011, §6). */
type Compensation = (reason: string) => Promise<unknown>;

/** Converts idempotency records to their transact-item form (ADR-017). */
const idempotencyDataModel = new IdempotencyDataModel();

/**
 * The cell-based control plane tenant service. Implements the
 * Smithy-generated `TenantServiceService` interface (all eleven operations).
 * Receives static config in the constructor (cold start) and an immutable
 * `CallerContext` per operation — it never sees the raw event or a JWT
 * (context separation).
 */
export class TenantService implements TenantServiceService<CallerContext> {
  constructor(private readonly config: TenantServiceConfig) {}

  // -------------------------------------------------------------------
  // Tenant operations
  // -------------------------------------------------------------------

  CreateTenant = async (
    input: CreateTenantServerInput,
    context: CallerContext,
  ): Promise<CreateTenantServerOutput> => {
    const name = requireField(input.name, 'name');
    // adminEmail is pass-through: workflow input only, never persisted (ADR-004).
    const adminEmail = requireField(input.adminEmail, 'adminEmail');
    const now = new Date();
    const tenantId = ulid();

    // Optional idempotency (ADR-017): the item joins the placement
    // transaction, conditional on attribute_not_exists(PK). Its cancelled
    // condition marks the request as a replay of an earlier CreateTenant.
    const clientToken = input.clientToken;
    const requestHash =
      clientToken === undefined
        ? undefined
        : createTenantRequestHash({ name, description: input.description, adminEmail });
    const idempotencyItem =
      clientToken === undefined || requestHash === undefined
        ? undefined
        : idempotencyDataModel.toItem({
          clientToken,
          tenantId,
          requestHash,
          createdAt: now,
          expiresAt: Math.floor(now.getTime() / 1000) + IDEMPOTENCY_TTL_SECONDS,
        });

    const makeTenant = (cellId: string): TenantRecord => ({
      tenantId,
      name,
      description: input.description,
      cellId,
      status: 'CREATING',
      createdAt: now,
      updatedAt: now,
    });

    // §6 steps 1–2: candidate scan + bounded claim loop against existing cells.
    let placed;
    try {
      placed = await this.placeIntoExistingCell(makeTenant, now.toISOString(), idempotencyItem);
    } catch (error) {
      return this.replayOrRethrow(error, clientToken, requestHash);
    }

    let tenant: TenantRecord;
    let workflowInput: ProvisioningWorkflowInput;
    let compensate: Compensation;

    if (placed !== undefined) {
      // Existing cell: tenant create build only. Compensation is a single
      // CAS moving the tenant CREATING → CREATE_FAILED (§6).
      tenant = placed.tenant;
      workflowInput = {
        ...this.workflowSource(placed.cell),
        // M12 (T10): the initiating operator rides the execution input into
        // every build — resolved here, at StartExecution time (ADR-011).
        operatorId: context.operatorId,
        cellId: placed.cell.cellId,
        tenantId,
        tenantBuild: {
          operation: 'create',
          scriptPath: requireField(placed.cell.tenantScripts.create, 'cell.tenantScripts.create'),
          failedStatus: 'CREATE_FAILED',
          adminEmail,
        },
      };
      compensate = this.tenantCompensation(tenantId, 'CREATING', 'CREATE_FAILED');
    } else {
      // §6 step 3 — no candidate claimed (none found or budget exhausted):
      // create a new cell (CREATING, slot pre-claimed, definition stamped
      // from deployment config) together with the tenant, atomically.
      const definition = this.config.cellDefinition;
      const cell: CellRecord = {
        cellId: ulid(),
        status: 'CREATING',
        maxTenants: definition.maxTenants,
        tenantCount: 1,
        source: definition.source,
        cellScripts: definition.cellScripts,
        tenantScripts: definition.tenantScripts,
        createdAt: now,
        updatedAt: now,
      };
      tenant = makeTenant(cell.cellId);
      try {
        await this.config.placement.createCellWithTenant({
          cell,
          tenant,
          clientRequestToken: ulid(),
          idempotencyItem,
        });
      } catch (error) {
        if (error instanceof DuplicateTokenError) {
          return this.replayOrRethrow(error, clientToken, requestHash);
        }
        // Any other new-cell transaction failure is ambiguous: fail the
        // request, never retarget the same tenant (§6).
        throw new InternalServerError({
          message: `Tenant placement failed ambiguously: ${errorMessage(error)}`,
        });
      }
      workflowInput = {
        ...this.workflowSource(cell),
        operatorId: context.operatorId,
        cellId: cell.cellId,
        cellBuild: {
          operation: 'create',
          scriptPath: requireField(cell.cellScripts.create, 'cellDefinition.cellScripts.create'),
          failedStatus: 'CREATE_FAILED',
        },
        tenantId,
        tenantBuild: {
          operation: 'create',
          scriptPath: requireField(cell.tenantScripts.create, 'cellDefinition.tenantScripts.create'),
          failedStatus: 'CREATE_FAILED',
          adminEmail,
        },
      };
      // New-cell compensation is the paired transaction: BOTH records move
      // CREATING → CREATE_FAILED so compensation cannot leave only one
      // record recoverable (§6).
      compensate = (reason) =>
        this.config.placement.failCreatingCellAndTenant({
          cellKey: cellKey(cell.cellId),
          tenantKey: tenantKey(tenantId),
          statusReason: reason,
          updatedAt: new Date().toISOString(),
        });
    }

    await this.startWorkflow(`${tenantId}-create-${Date.now()}`, workflowInput, compensate);
    return { tenant: toSummary(tenant) };
  };

  GetTenant = async (
    input: GetTenantServerInput,
    _context: CallerContext,
  ): Promise<GetTenantServerOutput> => {
    const tenant = await this.getTenantOrThrow(requireField(input.tenantId, 'tenantId'));
    return { tenant: toSummary(tenant) };
  };

  UpdateTenant = async (
    input: UpdateTenantServerInput,
    _context: CallerContext,
  ): Promise<UpdateTenantServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');

    // Metadata only (field-ownership write, ADR-011): the update cannot
    // touch workflow-owned lifecycle fields. No state guard (§5).
    const setExpressions = ['#updatedAt = :updatedAt'];
    const expressionAttributeNames: Record<string, string> = {
      '#updatedAt': 'updatedAt',
    };
    const expressionAttributeValues: Record<string, unknown> = {
      ':updatedAt': new Date().toISOString(),
    };
    if (input.name !== undefined) {
      setExpressions.push('#name = :name');
      expressionAttributeNames['#name'] = 'name';
      expressionAttributeValues[':name'] = input.name;
    }
    if (input.description !== undefined) {
      setExpressions.push('#description = :description');
      expressionAttributeNames['#description'] = 'description';
      expressionAttributeValues[':description'] = input.description;
    }

    try {
      const updated = await this.config.tenantRepository.updateExisting(tenantKey(tenantId), {
        updateExpression: `SET ${setExpressions.join(', ')}`,
        expressionAttributeNames,
        expressionAttributeValues,
      });
      return { tenant: toSummary(updated) };
    } catch (error) {
      if (error instanceof RecordGoneError) {
        // The metadata write lost a race with a concurrent delete — 404, not
        // an unmodelled 500 (§7).
        throw new ResourceNotFoundError({ message: `Tenant ${tenantId} not found` });
      }
      throw error;
    }
  };

  DeleteTenant = async (
    input: DeleteTenantServerInput,
    context: CallerContext,
  ): Promise<DeleteTenantServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    const existing = await this.getTenantOrThrow(tenantId);

    if (IN_FLIGHT.includes(existing.status)) {
      throw new ConflictError({
        message: `Tenant ${tenantId} is ${existing.status}; wait for the operation to finish`,
      });
    }

    // Delete is allowed regardless of cell status (§5) — the cell record is
    // read only to resolve the stamped source and tenant delete script.
    const cell = await this.getCellForTenant(existing);

    const deleting = await this.transitionTenant(tenantId, TENANT_DELETABLE_STATUSES, 'DELETING');
    await this.startWorkflow(
      `${tenantId}-delete-${Date.now()}`,
      {
        ...this.workflowSource(cell),
        operatorId: context.operatorId,
        cellId: existing.cellId,
        tenantId,
        tenantBuild: {
          operation: 'delete',
          scriptPath: requireField(cell.tenantScripts.delete, 'cell.tenantScripts.delete'),
          failedStatus: 'DELETE_FAILED',
          adminEmail: '',
        },
      },
      this.tenantCompensation(tenantId, 'DELETING', 'DELETE_FAILED'),
    );
    return { tenant: toSummary(deleting) };
  };

  ListTenants = async (
    input: ListTenantsServerInput,
    _context: CallerContext,
  ): Promise<ListTenantsServerOutput> => {
    // Unfiltered listing uses GSI-2's static partition; the ?cellId= filter
    // uses the tenant items' GSI-1 partition. An unknown cellId naturally
    // yields an empty page — the filter is a query predicate, not a
    // resource lookup (§5).
    const query =
      input.cellId === undefined ? listTenantsQuery() : listTenantsByCellQuery(input.cellId);
    const page = await this.config.tenantRepository.queryIndex(
      query,
      input.maxResults,
      input.nextToken,
    );
    return {
      tenants: page.items.map(toSummary),
      nextToken: page.nextToken,
    };
  };

  GetResource = async (
    input: GetResourceServerInput,
    _context: CallerContext,
  ): Promise<GetResourceServerOutput> => {
    const tenant = await this.getTenantOrThrow(requireField(input.tenantId, 'tenantId'));
    // The tenant deployment's effective definition is the cell's stamped
    // definition (ADR-012) — resolved here, never stored on the tenant.
    const cell = await this.getCellForTenant(tenant);
    return {
      source: cell.source,
      scripts: cell.tenantScripts,
      status: tenant.status,
      statusReason: tenant.statusReason,
      lastBuildId: tenant.lastBuildId,
      cellId: tenant.cellId,
    };
  };

  UpdateResource = async (
    input: UpdateResourceServerInput,
    context: CallerContext,
  ): Promise<UpdateResourceServerOutput> => {
    const tenantId = requireField(input.tenantId, 'tenantId');
    const existing = await this.getTenantOrThrow(tenantId);

    // Allowed from ACTIVE and UPDATE_FAILED only. From CREATE_FAILED the
    // remediation is delete + recreate — the create script never completed.
    if (!UPDATABLE_STATUSES.includes(existing.status)) {
      throw new ConflictError({
        message: `Tenant ${tenantId} is ${existing.status}; the deployment can be re-applied from ACTIVE or UPDATE_FAILED`,
      });
    }

    // Cross-entity guard (§5): no tenant builds against a shared deployment
    // that is mid-change. This read-then-act check is the documented
    // tolerated one-directional guard — an overlap can fail a build but
    // never corrupts control plane state.
    const cell = await this.getCellForTenant(existing);
    if (cell.status !== 'ACTIVE') {
      throw new ConflictError({
        message: `Cell ${cell.cellId} is ${cell.status}; the tenant deployment can be re-applied only while its cell is ACTIVE`,
      });
    }

    const updating = await this.transitionTenant(tenantId, UPDATABLE_STATUSES, 'UPDATING');
    await this.startWorkflow(
      `${tenantId}-update-${Date.now()}`,
      {
        ...this.workflowSource(cell),
        operatorId: context.operatorId,
        cellId: existing.cellId,
        tenantId,
        tenantBuild: {
          operation: 'update',
          scriptPath: requireField(cell.tenantScripts.update, 'cell.tenantScripts.update'),
          failedStatus: 'UPDATE_FAILED',
          adminEmail: '',
        },
      },
      this.tenantCompensation(tenantId, 'UPDATING', 'UPDATE_FAILED'),
    );
    return { tenant: toSummary(updating) };
  };

  // -------------------------------------------------------------------
  // Cell operations
  // -------------------------------------------------------------------

  GetCell = async (
    input: GetCellServerInput,
    _context: CallerContext,
  ): Promise<GetCellServerOutput> => {
    const cell = await this.getCellOrThrow(requireField(input.cellId, 'cellId'));
    return { cell: toCellSummary(cell) };
  };

  ListCells = async (
    input: ListCellsServerInput,
    _context: CallerContext,
  ): Promise<ListCellsServerOutput> => {
    const page = await this.config.cellRepository.queryIndex(
      listCellsQuery(),
      input.maxResults,
      input.nextToken,
    );
    return {
      cells: page.items.map(toCellSummary),
      nextToken: page.nextToken,
    };
  };

  UpdateCell = async (
    input: UpdateCellServerInput,
    context: CallerContext,
  ): Promise<UpdateCellServerOutput> => {
    const cellId = requireField(input.cellId, 'cellId');
    const existing = await this.getCellOrThrow(cellId);

    // Allowed from ACTIVE/UPDATE_FAILED; 409 if in-flight or CREATE_FAILED —
    // re-running the update script against a half-created shared deployment
    // would break the create/update script contract (§5). Remediation for a
    // failed cell create is tenant delete + cell delete.
    if (!UPDATABLE_STATUSES.includes(existing.status)) {
      throw new ConflictError({
        message: `Cell ${cellId} is ${existing.status}; the shared deployment can be re-applied from ACTIVE or UPDATE_FAILED`,
      });
    }

    const updating = await this.transitionCell(cellId, UPDATABLE_STATUSES, 'UPDATING');
    await this.startWorkflow(
      `${cellId}-cell-update-${Date.now()}`,
      {
        ...this.workflowSource(existing),
        operatorId: context.operatorId,
        cellId,
        cellBuild: {
          operation: 'update',
          scriptPath: requireField(existing.cellScripts.update, 'cell.cellScripts.update'),
          failedStatus: 'UPDATE_FAILED',
        },
      },
      this.cellCompensation(cellId, 'UPDATING', 'UPDATE_FAILED'),
    );
    return { cell: toCellSummary(updating) };
  };

  DeleteCell = async (
    input: DeleteCellServerInput,
    context: CallerContext,
  ): Promise<DeleteCellServerOutput> => {
    const cellId = requireField(input.cellId, 'cellId');
    const existing = await this.getCellOrThrow(cellId);

    // ADR-014: the emptiness check and the DELETING transition are ONE
    // atomic conditional UpdateItem (status IN {ACTIVE, *_FAILED} AND
    // tenantCount = 0) — a read-then-write would let a concurrent placement
    // claim a slot before DELETING lands. Condition failure maps to the 409.
    let deleting: CellRecord;
    try {
      deleting = await this.config.cellRepository.transitionStatus(
        cellKey(cellId),
        deleteCellTransition(new Date().toISOString()),
      );
    } catch (error) {
      if (error instanceof StaleTransitionError) {
        throw new ConflictError({
          message: `Cell ${cellId} cannot be deleted — it is occupied, in-flight, or was modified concurrently`,
        });
      }
      throw error;
    }

    await this.startWorkflow(
      `${cellId}-cell-delete-${Date.now()}`,
      {
        ...this.workflowSource(existing),
        operatorId: context.operatorId,
        cellId,
        cellBuild: {
          operation: 'delete',
          scriptPath: requireField(existing.cellScripts.delete, 'cell.cellScripts.delete'),
          failedStatus: 'DELETE_FAILED',
        },
      },
      this.cellCompensation(cellId, 'DELETING', 'DELETE_FAILED'),
    );
    return { cell: toCellSummary(deleting) };
  };

  // -------------------------------------------------------------------
  // Placement (§6)
  // -------------------------------------------------------------------

  /**
   * §6 steps 1–2: nominate candidates from GSI-1 (eventually consistent —
   * never a guard; the conditional claim on the base table decides), filter
   * client-side for ACTIVE with free capacity, and attempt at most
   * {@link MAX_CLAIM_ATTEMPTS} claims, oldest first. A lost race moves to
   * the next candidate; an ambiguous outcome fails the request — the same
   * tenant is never retargeted. Returns `undefined` when no candidate was
   * claimed (fall through to new-cell creation).
   */
  private async placeIntoExistingCell(
    makeTenant: (cellId: string) => TenantRecord,
    updatedAt: string,
    idempotencyItem?: IdempotencyItem,
  ): Promise<{ cell: CellRecord; tenant: TenantRecord } | undefined> {
    let attempts = 0;
    let nextToken: string | undefined;
    do {
      const page = await this.config.cellRepository.queryIndex(
        listCellsQuery(),
        undefined,
        nextToken,
      );
      nextToken = page.nextToken;
      for (const cell of page.items) {
        // Client-side filter (§6 step 1): placement requires the cell ACTIVE
        // with free capacity — the same condition the claim re-checks.
        if (cell.status !== 'ACTIVE' || cell.tenantCount >= cell.maxTenants) {
          continue;
        }
        const tenant = makeTenant(cell.cellId);
        attempts += 1;
        try {
          await this.config.placement.placeTenantInCell({
            cellKey: cellKey(cell.cellId),
            tenant,
            updatedAt,
            clientRequestToken: ulid(),
            idempotencyItem,
          });
          return { cell, tenant };
        } catch (error) {
          if (error instanceof PlacementRaceLostError) {
            if (attempts >= MAX_CLAIM_ATTEMPTS) {
              // Candidate budget exhausted: fall through to new-cell
              // creation — over-provisioning, never a failed onboard (§6).
              return undefined;
            }
            continue;
          }
          if (error instanceof DuplicateTokenError) {
            // Replay of an earlier CreateTenant — handled by the caller
            // (ADR-017), never converted to a 500.
            throw error;
          }
          // AmbiguousTransactionError (or anything else): the outcome is
          // unknown — fail the request; NEVER retarget this tenant (§6).
          throw new InternalServerError({
            message: `Tenant placement failed ambiguously: ${errorMessage(error)}`,
          });
        }
      }
    } while (nextToken !== undefined);
    return undefined;
  }

  /**
   * ADR-017: replays the original CreateTenant outcome for a duplicate
   * `clientToken`, or rethrows when the error is not a replay. The
   * idempotency record is authoritative regardless of its `expiresAt` —
   * DynamoDB TTL is garbage collection, not semantics.
   */
  private async replayOrRethrow(
    error: unknown,
    clientToken: string | undefined,
    requestHash: string | undefined,
  ): Promise<CreateTenantServerOutput> {
    if (
      !(error instanceof DuplicateTokenError) ||
      clientToken === undefined ||
      requestHash === undefined
    ) {
      throw error;
    }
    const record = await this.config.idempotencyRepository.get(idempotencyKey(clientToken));
    if (record === undefined) {
      // The transaction saw the record but the read did not: TTL garbage
      // collection raced the replay. A retry (same or new token) onboards
      // a new tenant — surface the conflict rather than guessing.
      throw new ConflictError({
        message: 'clientToken was already used, but its idempotency record has expired — verify via ListTenants before retrying',
      });
    }
    if (record.requestHash !== requestHash) {
      throw new ConflictError({
        message: 'clientToken was already used with different request parameters',
      });
    }
    const tenant = await this.config.tenantRepository.get(tenantKey(record.tenantId));
    if (tenant === undefined) {
      throw new ConflictError({
        message: `clientToken was already used to onboard tenant ${record.tenantId}, which no longer exists — retry with a new token`,
      });
    }
    // The original outcome, whatever its current lifecycle status — a
    // CREATING tenant is polled as normal, a CREATE_FAILED one surfaces
    // the original failure.
    return { tenant: toSummary(tenant) };
  }

  // -------------------------------------------------------------------
  // Shared internals
  // -------------------------------------------------------------------

  /** Reads a tenant or throws the modelled 404. */
  private async getTenantOrThrow(tenantId: string): Promise<TenantRecord> {
    const tenant = await this.config.tenantRepository.get(tenantKey(tenantId));
    if (tenant === undefined) {
      throw new ResourceNotFoundError({ message: `Tenant ${tenantId} not found` });
    }
    return tenant;
  }

  /** Reads a cell or throws the modelled 404. */
  private async getCellOrThrow(cellId: string): Promise<CellRecord> {
    const cell = await this.config.cellRepository.get(cellKey(cellId));
    if (cell === undefined) {
      throw new ResourceNotFoundError({ message: `Cell ${cellId} not found` });
    }
    return cell;
  }

  /**
   * Resolves the cell a tenant is placed in. Slot lifetime = tenant record
   * lifetime (ADR-013), so a tenant referencing a missing cell is an
   * invariant violation — an internal error, never a client 404.
   */
  private async getCellForTenant(tenant: TenantRecord): Promise<CellRecord> {
    const cell = await this.config.cellRepository.get(cellKey(tenant.cellId));
    if (cell === undefined) {
      throw new InternalServerError({
        message: `Tenant ${tenant.tenantId} references missing cell ${tenant.cellId}`,
      });
    }
    return cell;
  }

  /**
   * Compare-and-set tenant lifecycle transition on the operation's accepted
   * status set (§5). A stale transition (record concurrently mutated or
   * gone) maps to the 409.
   */
  private async transitionTenant(
    tenantId: string,
    fromAnyOf: readonly LifecycleStatus[],
    to: InFlightLifecycleStatus,
  ): Promise<TenantRecord> {
    try {
      return await this.config.tenantRepository.transitionStatus(tenantKey(tenantId), {
        fromAnyOf,
        to,
        updatedAt: new Date().toISOString(),
        removeFields: ['statusReason'],
      });
    } catch (error) {
      if (error instanceof StaleTransitionError) {
        throw new ConflictError({
          message: `Tenant ${tenantId} was modified concurrently; re-read and retry`,
        });
      }
      throw error;
    }
  }

  /** Compare-and-set cell lifecycle transition — same discipline as the tenant's. */
  private async transitionCell(
    cellId: string,
    fromAnyOf: readonly LifecycleStatus[],
    to: InFlightLifecycleStatus,
  ): Promise<CellRecord> {
    try {
      return await this.config.cellRepository.transitionStatus(cellKey(cellId), {
        fromAnyOf,
        to,
        updatedAt: new Date().toISOString(),
        removeFields: ['statusReason'],
      });
    } catch (error) {
      if (error instanceof StaleTransitionError) {
        throw new ConflictError({
          message: `Cell ${cellId} was modified concurrently; re-read and retry`,
        });
      }
      throw error;
    }
  }

  /** Single-CAS tenant compensation: in-flight status → the matching *_FAILED (§6). */
  private tenantCompensation(
    tenantId: string,
    inFlight: InFlightLifecycleStatus,
    failed: FailedLifecycleStatus,
  ): Compensation {
    return (reason) =>
      this.config.tenantRepository.transitionStatus(tenantKey(tenantId), {
        fromAnyOf: [inFlight],
        to: failed,
        updatedAt: new Date().toISOString(),
        setFields: { statusReason: reason },
      });
  }

  /** Single-CAS cell compensation: in-flight status → the matching *_FAILED (§6). */
  private cellCompensation(
    cellId: string,
    inFlight: InFlightLifecycleStatus,
    failed: FailedLifecycleStatus,
  ): Compensation {
    return (reason) =>
      this.config.cellRepository.transitionStatus(cellKey(cellId), {
        fromAnyOf: [inFlight],
        to: failed,
        updatedAt: new Date().toISOString(),
        setFields: { statusReason: reason },
      });
  }

  /**
   * Resolves the workflow's source fields from a cell's stamped definition.
   * `sourceVersion` is the stamped supply-chain pin (T5/M10) — the empty
   * string means unpinned, and the workflow's source-pin Choice then skips
   * the CodeBuild `SourceVersion` override (input contract, §7).
   */
  private workflowSource(
    cell: CellRecord,
  ): { sourceType: string; sourceLocation: string; sourceVersion: string } {
    const source: StampedSourceDefinition = cell.source;
    return {
      sourceType: requireField(source.type, 'cell.source.type'),
      sourceLocation: requireField(source.location, 'cell.source.location'),
      sourceVersion: source.sourceVersion ?? '',
    };
  }

  /**
   * Starts provisioning; a rejected start is compensated exactly for the
   * in-flight state the operation created (§6). Compensation is best-effort
   * (ADR-011) — its own failure must not mask the original start failure.
   */
  private async startWorkflow(
    name: string,
    input: ProvisioningWorkflowInput,
    compensate: Compensation,
  ): Promise<void> {
    try {
      await this.config.sfnClient.send(
        new StartExecutionCommand({
          stateMachineArn: this.config.stateMachineArn,
          // One execution per entity + operation attempt; timestamp keeps retries unique.
          name,
          input: JSON.stringify(input),
        }),
      );
    } catch (error) {
      const reason = `Failed to start provisioning workflow: ${errorMessage(error)}`;
      try {
        await compensate(reason);
      } catch {
        // Best-effort (ADR-011): surface the original start failure below.
      }
      throw error;
    }
  }
}

/** Projects the tenant domain record to the API summary (including its placement). */
function toSummary(record: TenantRecord): TenantSummary {
  return {
    tenantId: record.tenantId,
    name: record.name,
    description: record.description,
    cellId: record.cellId,
    status: record.status,
    statusReason: record.statusReason,
    lastBuildId: record.lastBuildId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Projects the cell domain record to the API summary (stamped definition included). */
function toCellSummary(record: CellRecord): CellSummary {
  return {
    cellId: record.cellId,
    status: record.status,
    maxTenants: record.maxTenants,
    tenantCount: record.tenantCount,
    source: record.source,
    cellScripts: record.cellScripts,
    tenantScripts: record.tenantScripts,
    lastBuildId: record.lastBuildId,
    statusReason: record.statusReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
}

/**
 * Narrows a Smithy-optional input field. Required fields are enforced by the
 * generated validators before the operation runs - absence here is a
 * framework bug, not a client error.
 */
function requireField<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new InternalServerError({ message: `Validated input missing required field '${name}'` });
  }
  return value;
}
