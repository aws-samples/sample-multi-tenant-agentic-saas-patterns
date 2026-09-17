// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { ArnFormat, Duration, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import { nagFindingResource, acknowledgeGranularFinding, suppressTemplateScanners } from '../shared/nag';

export interface ProvisioningWorkflowProps {
  /** The control plane table (cells + tenants; terminal state is written directly to it). */
  readonly table: dynamodb.ITable;
}

/**
 * Catchable per-build budget (task-level TimeoutSeconds on each StartBuild
 * task). A timeout surfaces as States.Timeout and is caught like a build
 * failure (architecture.md §7).
 */
const BUILD_TIMEOUT = Duration.hours(1);

/**
 * Execution timeout: greater than the sum of both build-task budgets plus
 * terminal-write recovery margin (§7). It is a final safety net, not the
 * normal timeout path — that is the catchable task-level timeout above.
 */
const EXECUTION_TIMEOUT = Duration.hours(3);

/**
 * M17 (threat T16): each CreateTenant/UpdateResource/UpdateCell/DeleteCell
 * fans out to CodeBuild, so a leaked operator token or a runaway client is
 * a cost/concurrency amplification vector. Capping concurrent builds per
 * project bounds the parallel spend; excess StartBuild requests queue
 * rather than fan out. Sample-appropriate value — tune for real fleets.
 */
const CONCURRENT_BUILD_LIMIT = 5;

/** The inline buildspec — every execution overrides source and runs its resolved script. */
const INLINE_BUILDSPEC = [
  'version: 0.2',
  'phases:',
  '  build:',
  '    commands:',
  '      - bash "$SCRIPT_PATH"',
].join('\n');

/**
 * The provisioning workflow (architecture.md §7).
 *
 * Resolved execution input (ADR-011 — the service resolves sources, script
 * paths, and failure statuses; the workflow rereads no mutable records):
 *
 * ```
 * {
 *   "sourceType": "GITHUB", "sourceLocation": "https://...",
 *   "sourceVersion": "<full commit SHA or ''>",
 *   "operatorId": "<authorizer sub>",
 *   "cellId": "...",
 *   "cellBuild":   { "operation": "create|update|delete",
 *                    "scriptPath": "...", "failedStatus": "..." },   // optional
 *   "tenantId": "...",                                               // when tenantBuild present
 *   "tenantBuild": { "operation": "create|update|delete",
 *                    "scriptPath": "...", "failedStatus": "...",
 *                    "adminEmail": "..." }                           // optional
 * }
 * ```
 *
 * `cellBuild` and `tenantBuild` are each optional; the combination encodes
 * the trigger (§7): CreateTenant into an existing cell (tenant create only),
 * CreateTenant requiring a new cell (cell create + tenant create),
 * UpdateResource (tenant update), DeleteTenant (tenant delete),
 * UpdateCell (cell update), DeleteCell (cell delete).
 *
 * Input contract: `tenantBuild.adminEmail`, `sourceVersion`, and
 * `operatorId` are always present — the service supplies an empty string
 * for non-create operations / an unpinned source. A non-empty
 * `sourceVersion` (the stamped supply-chain pin, T5/M10) becomes the
 * CodeBuild `SourceVersion` override; `operatorId` (the verified JWT sub)
 * is forwarded to every build as `OPERATOR_ID` so application-plane changes
 * are attributable to the initiating operator, not just the shared fleet
 * role (T10/M12).
 *
 * Two shared CodeBuild projects with distinct service roles separate cell
 * builds from tenant builds (ADR-002, ADR-012). Every lifecycle transition
 * is compare-and-set on the exact expected status; failure writes are
 * conditional on attribute_exists(PK); the tenant-delete terminal write is a
 * TransactWriteItems (record removal + slot release, §6) with a stable
 * ClientRequestToken derived from the execution id. No unconditional writes.
 *
 * CustomState raw ASL is required because the typed CodeBuildStartBuild task
 * does not expose Source*Override parameters, and there is no typed
 * TransactWriteItems task.
 */
export class ProvisioningWorkflow extends Construct {
  readonly stateMachine: sfn.StateMachine;
  /** Shared project for cell builds — its role owns /application-plane/cells/*. */
  readonly cellProject: codebuild.Project;
  /** Shared project for tenant builds — its role reads cell parameters but cannot mutate them. */
  readonly tenantProject: codebuild.Project;

  private readonly table: dynamodb.ITable;

  constructor(scope: Construct, id: string, props: ProvisioningWorkflowProps) {
    super(scope, id);
    this.table = props.table;

    // ------------------------------------------------------------------
    // Two shared CodeBuild projects (ADR-002 refined by ADR-012). Base
    // source is NO_SOURCE + dummy buildspec: every execution overrides both.
    // ⚠️ The service roles are the provisioning blast radius — THE hardening
    // point of the sample. Distinct roles enforce the cell-script /
    // tenant-script permission boundary (§7).
    // ------------------------------------------------------------------
    // M15 (T13): explicit CodeBuild log groups with bounded retention —
    // the service-created default groups never expire.
    const cellProjectLogs = projectLogGroup(this, 'CellProjectLogs');
    this.cellProject = new codebuild.Project(this, 'CellProject', {
      description: 'Cell provisioning (shared cell deployment) - source and buildspec are overridden per StartBuild',
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: { build: { commands: ['echo "This buildspec is always overridden"'] } },
      }),
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0 },
      // M17 (T16): bound the cost/concurrency amplification of a leaked
      // token or runaway client — excess builds queue, they do not fan out.
      concurrentBuildLimit: CONCURRENT_BUILD_LIMIT,
      logging: { cloudWatch: { logGroup: cellProjectLogs } },
    });
    acknowledgeCodeBuildDefaults(this.cellProject, cellProjectLogs);
    // Cell role: read shared resources; own the per-cell namespace.
    this.cellProject.addToRolePolicy(readSharedResourcesStatement(this));
    this.cellProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ManageCellNamespace',
        actions: [
          'ssm:GetParameter',
          'ssm:GetParameters',
          'ssm:GetParametersByPath',
          'ssm:PutParameter',
          'ssm:DeleteParameter',
          'ssm:AddTagsToResource',
        ],
        resources: [ssmParameterArn(this, '/application-plane/cells/*')],
      }),
    );
    acknowledgeSsmNamespaceGrant(this.cellProject, '/application-plane/shared/*');
    acknowledgeSsmNamespaceGrant(this.cellProject, '/application-plane/cells/*');

    const tenantProjectLogs = projectLogGroup(this, 'TenantProjectLogs');
    this.tenantProject = new codebuild.Project(this, 'TenantProject', {
      description: 'Tenant provisioning (per-tenant deployment) - source and buildspec are overridden per StartBuild',
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: { build: { commands: ['echo "This buildspec is always overridden"'] } },
      }),
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0 },
      // M17 (T16) and M15 (T13) — see CellProject.
      concurrentBuildLimit: CONCURRENT_BUILD_LIMIT,
      logging: { cloudWatch: { logGroup: tenantProjectLogs } },
    });
    acknowledgeCodeBuildDefaults(this.tenantProject, tenantProjectLogs);
    // Tenant role: read shared AND cell parameters (the ADR-010 contract
    // extended by §7 — tenants read their cell's published identifiers), own
    // the per-tenant namespace. It must NOT be able to mutate cell parameters.
    this.tenantProject.addToRolePolicy(readSharedResourcesStatement(this));
    this.tenantProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadCellNamespace',
        actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
        resources: [ssmParameterArn(this, '/application-plane/cells/*')],
      }),
    );
    this.tenantProject.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ManageTenantNamespace',
        actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter', 'ssm:AddTagsToResource'],
        resources: [ssmParameterArn(this, '/application-plane/tenants/*')],
      }),
    );
    acknowledgeSsmNamespaceGrant(this.tenantProject, '/application-plane/shared/*');
    acknowledgeSsmNamespaceGrant(this.tenantProject, '/application-plane/cells/*');
    acknowledgeSsmNamespaceGrant(this.tenantProject, '/application-plane/tenants/*');

    // ------------------------------------------------------------------
    // States — defined leaf-first so transitions can reference them.
    // ------------------------------------------------------------------
    const done = new sfn.Succeed(this, 'Done');

    // ---- Tenant phase (phase 2) ----------------------------------------

    // Failure write: build failure, task timeout, or terminal-write retry
    // exhaustion → tenant to the resolved failedStatus. attribute_exists(PK)
    // so it cannot recreate a concurrently deleted record as a ghost.
    const failTenant = this.updateItemTask('FailTenant', tenantKey(), {
      updateExpression: 'SET #status = :failed, statusReason = :reason, updatedAt = :now',
      conditionExpression: 'attribute_exists(PK)',
      expressionAttributeValues: {
        ':failed': attrAt('$.tenantBuild.failedStatus'),
        ':reason': attrReason('Tenant provisioning failed'),
        ':now': attrAt('$$.State.EnteredTime'),
      },
    });

    // Failure write carrying the build evidence (README contract): the
    // normalized `$.failure.{buildArn,buildStatus}` fields go into
    // statusReason and lastBuildId. Extracting only these two short fields
    // (never the raw Cause string) keeps statusReason bounded.
    const failTenantWithBuild = this.updateItemTask('FailTenantWithBuild', tenantKey(), {
      updateExpression:
        'SET #status = :failed, statusReason = :reason, lastBuildId = :buildArn, updatedAt = :now',
      conditionExpression: 'attribute_exists(PK)',
      expressionAttributeValues: {
        ':failed': attrAt('$.tenantBuild.failedStatus'),
        ':reason': attrBuildFailureReason('Tenant provisioning failed'),
        ':buildArn': attrAt('$.failure.buildArn'),
        ':now': attrAt('$$.State.EnteredTime'),
      },
    });

    // Build-failure evidence extraction (tenant). Only the RunTenantBuild
    // Catch enters here, so a States.TaskFailed Cause is the .sync task's
    // Build JSON by contract; every field access is Choice-guarded so the
    // failure path can never itself fail on a missing field, and anything
    // unexpected (task timeout, odd shape) falls through to the generic
    // write keyed off $.error.Error.
    const {
      entry: tenantBuildFailure,
    } = this.buildFailureEvidenceChain('Tenant', failTenantWithBuild, failTenant);

    // Tenant-delete transaction cancellation / retry exhaustion outcome:
    // read the tenant — absence proves the prior delete committed (§7).
    const failTenantDelete = this.updateItemTask('FailTenantDelete', tenantKey(), {
      updateExpression: 'SET #status = :failed, statusReason = :reason, updatedAt = :now',
      conditionExpression: 'attribute_exists(PK) AND #status = :deleting',
      expressionAttributeValues: {
        ':failed': attr('DELETE_FAILED'),
        ':deleting': attr('DELETING'),
        ':reason': attrReason('Tenant delete failed'),
        ':now': attrAt('$$.State.EnteredTime'),
      },
    });

    const getTenantRecord = new tasks.DynamoGetItem(this, 'GetTenantRecord', {
      table: this.table,
      key: tenantKey(),
      consistentRead: true,
      resultPath: '$.tenantRecord',
    });
    getTenantRecord.addRetry(transientRetry());
    const tenantDeleteOutcome = new sfn.Choice(this, 'TenantDeleteOutcome')
      // Record still present: the transaction genuinely failed.
      .when(sfn.Condition.isPresent('$.tenantRecord.Item'), failTenantDelete)
      // Missing: a prior attempt committed — the delete succeeded.
      .otherwise(done);
    getTenantRecord.next(tenantDeleteOutcome);

    // §6 transaction-shape contract (owned by workstream B — do not alter):
    // DeleteItem tenant CONDITION attribute_exists(PK) AND status = DELETING
    // + UpdateItem cell tenantCount - 1 CONDITION attribute_exists(PK) AND
    // tenantCount > 0, stable ClientRequestToken. Record removal and slot
    // release cannot diverge; the item-state conditions make replays safe
    // beyond DynamoDB's finite token window (ADR-013).
    const deleteTenantTransact = new sfn.CustomState(this, 'DeleteTenantRecord', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::aws-sdk:dynamodb:transactWriteItems',
        Parameters: {
          'TransactItems': [
            {
              Delete: {
                TableName: this.table.tableName,
                Key: rawTenantKey(),
                ConditionExpression: 'attribute_exists(PK) AND #status = :deleting',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':deleting': { S: 'DELETING' } },
              },
            },
            {
              Update: {
                TableName: this.table.tableName,
                Key: rawCellKey(),
                UpdateExpression: 'SET tenantCount = tenantCount - :one, updatedAt = :now',
                ConditionExpression: 'attribute_exists(PK) AND tenantCount > :zero',
                ExpressionAttributeValues: {
                  ':one': { N: '1' },
                  ':zero': { N: '0' },
                  ':now': { 'S.$': '$$.State.EnteredTime' },
                },
              },
            },
          ],
          // Stable per execution: short-window duplicate suppression for
          // identical automatic retries (§7). Hashed to fit the 36-char cap.
          'ClientRequestToken.$': "States.Hash(States.Format('tenant-delete:{}', $$.Execution.Id), 'MD5')",
        },
        ResultPath: null,
      },
    });
    addTerminalWriteRetries(deleteTenantTransact);
    deleteTenantTransact.addCatch(getTenantRecord, { resultPath: '$.error' });
    deleteTenantTransact.next(done);

    // Terminal success for tenant create/update: CAS to ACTIVE + lastBuildId.
    const setTenantActiveAfterCreate = this.setActiveTask(
      'SetTenantActiveAfterCreate', tenantKey(), 'CREATING', '$.tenantBuildResult.Build.Arn');
    const setTenantActiveAfterUpdate = this.setActiveTask(
      'SetTenantActiveAfterUpdate', tenantKey(), 'UPDATING', '$.tenantBuildResult.Build.Arn');
    // Retry exhaustion routes through the same conditional *_FAILED
    // transition as a build failure (§7 point 3).
    setTenantActiveAfterCreate.addCatch(failTenant, { resultPath: '$.error' });
    setTenantActiveAfterUpdate.addCatch(failTenant, { resultPath: '$.error' });

    const tenantSuccessRouter = new sfn.Choice(this, 'TenantBuildSucceeded')
      .when(sfn.Condition.stringEquals('$.tenantBuild.operation', 'delete'), deleteTenantTransact)
      .when(sfn.Condition.stringEquals('$.tenantBuild.operation', 'update'), setTenantActiveAfterUpdate)
      .otherwise(setTenantActiveAfterCreate);

    const runTenantBuild = this.buildTask('RunTenantBuild', this.tenantProject, '$.tenantBuildResult', [
      envVar('SCRIPT_PATH', '$.tenantBuild.scriptPath'),
      envVar('TENANT_ID', '$.tenantId'),
      envVar('CELL_ID', '$.cellId'),
      envVar('OPERATION', '$.tenantBuild.operation'),
      // Create only; the service supplies an empty string otherwise (§7).
      envVar('ADMIN_EMAIL', '$.tenantBuild.adminEmail'),
      // M12 (T10): the initiating operator (verified JWT sub) — scripts and
      // build logs can attribute application-plane changes to an operator,
      // not just the shared fleet role.
      envVar('OPERATOR_ID', '$.operatorId'),
    ]);
    for (const variant of runTenantBuild.variants) {
      variant.addCatch(tenantBuildFailure, { resultPath: '$.error' });
      variant.next(tenantSuccessRouter);
    }

    const checkTenantBuild = new sfn.Choice(this, 'TenantBuildRequested')
      .when(sfn.Condition.isPresent('$.tenantBuild'), runTenantBuild.entry)
      .otherwise(done);

    // ---- Cell phase (phase 1) -------------------------------------------

    // Cell build failure with a pending tenant build (new-cell onboarding):
    // one transaction moves cell AND tenant CREATING→CREATE_FAILED so
    // compensation cannot leave only one record recoverable (§6, ADR-013).
    const failCellAndTenant = new sfn.CustomState(this, 'FailCellAndTenant', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::aws-sdk:dynamodb:transactWriteItems',
        Parameters: {
          'TransactItems': [
            {
              Update: {
                TableName: this.table.tableName,
                Key: rawCellKey(),
                UpdateExpression: 'SET #status = :failed, statusReason = :reason, updatedAt = :now',
                ConditionExpression: 'attribute_exists(PK) AND #status = :creating',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':failed': { S: 'CREATE_FAILED' },
                  ':creating': { S: 'CREATING' },
                  ':reason': { 'S.$': "States.Format('Cell provisioning failed: {}', $.error.Error)" },
                  ':now': { 'S.$': '$$.State.EnteredTime' },
                },
              },
            },
            {
              Update: {
                TableName: this.table.tableName,
                Key: rawTenantKey(),
                UpdateExpression: 'SET #status = :failed, statusReason = :reason, updatedAt = :now',
                ConditionExpression: 'attribute_exists(PK) AND #status = :creating',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':failed': { S: 'CREATE_FAILED' },
                  ':creating': { S: 'CREATING' },
                  ':reason': { S: 'cell provisioning failed' },
                  ':now': { 'S.$': '$$.State.EnteredTime' },
                },
              },
            },
          ],
          'ClientRequestToken.$': "States.Hash(States.Format('cell-failure:{}', $$.Execution.Id), 'MD5')",
        },
        ResultPath: null,
      },
    });
    addTerminalWriteRetries(failCellAndTenant);

    // Cell-only failure write: cell to the resolved failedStatus.
    const failCell = this.updateItemTask('FailCell', cellKey(), {
      updateExpression: 'SET #status = :failed, statusReason = :reason, updatedAt = :now',
      conditionExpression: 'attribute_exists(PK)',
      expressionAttributeValues: {
        ':failed': attrAt('$.cellBuild.failedStatus'),
        ':reason': attrReason('Cell provisioning failed'),
        ':now': attrAt('$$.State.EnteredTime'),
      },
    });

    const cellFailureRouter = new sfn.Choice(this, 'CellFailureHasTenant')
      .when(sfn.Condition.isPresent('$.tenantBuild'), failCellAndTenant)
      .otherwise(failCell);

    // With-build variants (README contract): the cell record additionally
    // gets lastBuildId and a statusReason naming the failed build. The
    // paired transaction keeps the exact same keys, conditions, and token —
    // only WHAT is written changes. The tenant half stays generic: its
    // lastBuildId refers to tenant builds, and the failed build is the cell's.
    const failCellAndTenantWithBuild = new sfn.CustomState(this, 'FailCellAndTenantWithBuild', {
      stateJson: {
        Type: 'Task',
        Resource: 'arn:aws:states:::aws-sdk:dynamodb:transactWriteItems',
        Parameters: {
          'TransactItems': [
            {
              Update: {
                TableName: this.table.tableName,
                Key: rawCellKey(),
                UpdateExpression:
                  'SET #status = :failed, statusReason = :reason, lastBuildId = :buildArn, updatedAt = :now',
                ConditionExpression: 'attribute_exists(PK) AND #status = :creating',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':failed': { S: 'CREATE_FAILED' },
                  ':creating': { S: 'CREATING' },
                  ':reason': {
                    'S.$':
                      "States.Format('Cell provisioning failed: build {} ended with status {}', $.failure.buildArn, $.failure.buildStatus)",
                  },
                  ':buildArn': { 'S.$': '$.failure.buildArn' },
                  ':now': { 'S.$': '$$.State.EnteredTime' },
                },
              },
            },
            {
              Update: {
                TableName: this.table.tableName,
                Key: rawTenantKey(),
                UpdateExpression: 'SET #status = :failed, statusReason = :reason, updatedAt = :now',
                ConditionExpression: 'attribute_exists(PK) AND #status = :creating',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':failed': { S: 'CREATE_FAILED' },
                  ':creating': { S: 'CREATING' },
                  ':reason': { S: 'cell provisioning failed' },
                  ':now': { 'S.$': '$$.State.EnteredTime' },
                },
              },
            },
          ],
          'ClientRequestToken.$': "States.Hash(States.Format('cell-failure:{}', $$.Execution.Id), 'MD5')",
        },
        ResultPath: null,
      },
    });
    addTerminalWriteRetries(failCellAndTenantWithBuild);

    const failCellWithBuild = this.updateItemTask('FailCellWithBuild', cellKey(), {
      updateExpression:
        'SET #status = :failed, statusReason = :reason, lastBuildId = :buildArn, updatedAt = :now',
      conditionExpression: 'attribute_exists(PK)',
      expressionAttributeValues: {
        ':failed': attrAt('$.cellBuild.failedStatus'),
        ':reason': attrBuildFailureReason('Cell provisioning failed'),
        ':buildArn': attrAt('$.failure.buildArn'),
        ':now': attrAt('$$.State.EnteredTime'),
      },
    });

    const cellFailureRouterWithBuild = new sfn.Choice(this, 'CellFailureHasTenantWithBuild')
      .when(sfn.Condition.isPresent('$.tenantBuild'), failCellAndTenantWithBuild)
      .otherwise(failCellWithBuild);

    // Build-failure evidence extraction (cell) — see the tenant chain.
    const {
      entry: cellBuildFailure,
    } = this.buildFailureEvidenceChain('Cell', cellFailureRouterWithBuild, cellFailureRouter);

    // Cell-delete condition failure / retry exhaustion outcome: read the
    // cell — absence proves the prior delete committed (§7, ADR-014).
    const failCellDelete = this.updateItemTask('FailCellDelete', cellKey(), {
      updateExpression: 'SET #status = :failed, statusReason = :reason, updatedAt = :now',
      conditionExpression: 'attribute_exists(PK)',
      expressionAttributeValues: {
        ':failed': attr('DELETE_FAILED'),
        ':reason': attrReason('Cell delete failed'),
        ':now': attrAt('$$.State.EnteredTime'),
      },
    });

    const getCellRecord = new tasks.DynamoGetItem(this, 'GetCellRecord', {
      table: this.table,
      key: cellKey(),
      consistentRead: true,
      resultPath: '$.cellRecord',
    });
    getCellRecord.addRetry(transientRetry());
    const cellDeleteOutcome = new sfn.Choice(this, 'CellDeleteOutcome')
      .when(sfn.Condition.isPresent('$.cellRecord.Item'), failCellDelete)
      .otherwise(done);
    getCellRecord.next(cellDeleteOutcome);

    // Terminal cell delete: conditional on emptiness as defence in depth —
    // the atomic DELETING transition (§5) already excluded occupancy.
    const deleteCellRecord = new tasks.DynamoDeleteItem(this, 'RemoveCellRecord', {
      table: this.table,
      key: cellKey(),
      conditionExpression: 'attribute_exists(PK) AND tenantCount = :zero',
      expressionAttributeValues: { ':zero': tasks.DynamoAttributeValue.fromNumber(0) },
      resultPath: sfn.JsonPath.DISCARD,
    });
    addTerminalWriteRetries(deleteCellRecord);
    deleteCellRecord.addCatch(getCellRecord, { resultPath: '$.error' });
    deleteCellRecord.next(done);

    // Terminal success for cell create/update: CAS to ACTIVE + lastBuildId.
    // The create variant continues to phase 2 (the new-cell onboarding).
    const setCellActiveAfterUpdate = this.setActiveTask(
      'SetCellActiveAfterUpdate', cellKey(), 'UPDATING', '$.cellBuildResult.Build.Arn');
    const setCellActiveAfterCreate = this.setActiveTask(
      'SetCellActiveAfterCreate', cellKey(), 'CREATING', '$.cellBuildResult.Build.Arn');
    // Retry exhaustion routes through the same *_FAILED transition as a
    // build failure — for new-cell onboarding that is the paired transaction,
    // so the pending tenant is failed too (§7 point 3).
    setCellActiveAfterUpdate.addCatch(cellFailureRouter, { resultPath: '$.error' });
    setCellActiveAfterCreate.addCatch(cellFailureRouter, { resultPath: '$.error' });
    setCellActiveAfterCreate.next(checkTenantBuild);

    const cellSuccessRouter = new sfn.Choice(this, 'CellBuildSucceeded')
      .when(sfn.Condition.stringEquals('$.cellBuild.operation', 'delete'), deleteCellRecord)
      .when(sfn.Condition.stringEquals('$.cellBuild.operation', 'update'), setCellActiveAfterUpdate)
      .otherwise(setCellActiveAfterCreate);

    const runCellBuild = this.buildTask('RunCellBuild', this.cellProject, '$.cellBuildResult', [
      envVar('SCRIPT_PATH', '$.cellBuild.scriptPath'),
      envVar('CELL_ID', '$.cellId'),
      envVar('OPERATION', '$.cellBuild.operation'),
      // M12 (T10) — see the tenant build.
      envVar('OPERATOR_ID', '$.operatorId'),
    ]);
    for (const variant of runCellBuild.variants) {
      variant.addCatch(cellBuildFailure, { resultPath: '$.error' });
      variant.next(cellSuccessRouter);
    }

    const checkCellBuild = new sfn.Choice(this, 'CellBuildRequested')
      .when(sfn.Condition.isPresent('$.cellBuild'), runCellBuild.entry)
      .otherwise(checkTenantBuild);

    // ------------------------------------------------------------------
    // State machine
    // ------------------------------------------------------------------
    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(checkCellBuild),
      timeout: EXECUTION_TIMEOUT,
      comment: 'Cell/tenant provisioning: optional cell build, optional tenant build, conditional terminal writes',
      // Full execution history to CloudWatch Logs (AwsSolutions-SF1) and
      // X-Ray tracing (AwsSolutions-SF2) - provisioning is the workflow
      // operators will debug, so every state transition is auditable.
      logs: {
        destination: new logs.LogGroup(this, 'StateMachineLogs', {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY, // sample only
        }),
        level: sfn.LogLevel.ALL,
      },
      tracingEnabled: true,
    });
    // The logging (logs:CreateLogDelivery etc.) and X-Ray (xray:PutTraceSegments
    // etc.) grants that CDK generates for the two settings above only work with
    // Resource: '*' - neither API family supports resource-level permissions:
    // https://docs.aws.amazon.com/step-functions/latest/dg/cw-logs.html#cloudwatch-iam-policy
    acknowledgeGranularFinding(
      this.stateMachine,
      'AwsSolutions-IAM5[Resource::*]',
      'CDK-generated grant for state machine logging (logs:CreateLogDelivery) and X-Ray tracing - these API families do not support resource-level permissions.',
    );

    // M17 (T16): a surge of provisioning executions is the cost/concurrency
    // amplification signature — a leaked token or runaway client hammering
    // CreateTenant. Alarm only (no actions): sample scope surfaces the
    // signal; a production control plane wires it to an operator channel.
    new cloudwatch.Alarm(this, 'ExecutionSurgeAlarm', {
      metric: this.stateMachine.metricStarted({
        period: Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 20,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'More than 20 provisioning executions started in 5 minutes - possible CreateTenant amplification (threat T16, mitigation M17).',
    });

    // CustomState does not auto-grant. Least-privilege (§7):
    // - StartBuild (+ .sync polling) on exactly the two shared projects.
    // - GetItem/UpdateItem/DeleteItem on the table — TransactWriteItems
    //   authorizes per contained operation, so no extra action is needed.
    this.stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['codebuild:StartBuild', 'codebuild:StopBuild', 'codebuild:BatchGetBuilds'],
        resources: [this.cellProject.projectArn, this.tenantProject.projectArn],
      }),
    );
    this.stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:PutRule', 'events:PutTargets', 'events:DescribeRule'],
        resources: [
          eventsRuleArn(this, 'StepFunctionsGetEventForCodeBuildStartBuildRule'),
        ],
      }),
    );
    // Item operations on the base table only — the workflow never queries
    // the GSIs. (The typed Dynamo tasks auto-grant; this statement is the
    // explicit, documented grant that also covers the two CustomState
    // TransactWriteItems tasks.)
    this.stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
        resources: [this.table.tableArn],
      }),
    );

    // Template-scanner (cfn_nag/checkov) annotations - travel with the
    // synthesized templates so scans of the committed integ snapshot see
    // the same documented decisions as cdk-nag at synth time.
    suppressTemplateScanners(this.node.findChild('StateMachineLogs'), {
      cfnNag: [{ id: 'W84', reason: 'Workflow logs carry state-transition metadata; default CloudWatch Logs SSE encryption at rest is sufficient for this sample.' }],
      checkov: [{ id: 'CKV_AWS_158', comment: 'Workflow logs carry state-transition metadata; default CloudWatch Logs SSE encryption at rest is sufficient for this sample.' }],
    });
    const spcmReason = 'Least-privilege policy with granular per-namespace statements (ADR-010); the statement-point count reflects explicit scoping, not over-breadth.';
    for (const role of [this.cellProject.role!, this.tenantProject.role!, this.stateMachine.role]) {
      suppressTemplateScanners(role.node.findChild('DefaultPolicy'), {
        cfnNag: [{ id: 'W76', reason: spcmReason }],
      });
    }
    // cfn_nag counterpart of the AwsSolutions-IAM5[Resource::*]
    // acknowledgment above - same CDK-generated grant, same reason.
    suppressTemplateScanners(this.stateMachine.role.node.findChild('DefaultPolicy'), {
      cfnNag: [{ id: 'W12', reason: 'CDK-generated grant for state machine logging (logs:CreateLogDelivery) and X-Ray tracing - these API families do not support resource-level permissions.' }],
    });
  }

  /**
   * Extracts build evidence from a caught build-task error (§7, README
   * contract). The `.sync` StartBuild task's `States.TaskFailed` Cause is
   * the JSON-serialized Build detail; a task timeout (`States.Timeout`) or
   * any unexpected shape carries no build JSON. Every access is
   * Choice-guarded so the failure path can never itself die on a missing
   * field: unmatched shapes fall through to `fallback` (the generic write
   * keyed off `$.error.Error`), and `States.StringToJson` only runs on a
   * present, non-null `States.TaskFailed` Cause. Matching shapes normalize
   * to `$.failure.{buildArn, buildStatus}` for `withBuild`.
   */
  private buildFailureEvidenceChain(
    prefix: string,
    withBuild: sfn.IChainable,
    fallback: sfn.IChainable,
  ): { entry: sfn.Choice } {
    // Both observed Cause layouts: `{ "Build": {...} }` and the Build
    // object at the top level — normalize either to the same two fields.
    const fromWrappedBuild = new sfn.Pass(this, `${prefix}FailureFromWrappedBuild`, {
      parameters: {
        buildArn: sfn.JsonPath.stringAt('$.failure.cause.Build.Arn'),
        buildStatus: sfn.JsonPath.stringAt('$.failure.cause.Build.BuildStatus'),
      },
      resultPath: '$.failure',
    }).next(withBuild);
    const fromBuild = new sfn.Pass(this, `${prefix}FailureFromBuild`, {
      parameters: {
        buildArn: sfn.JsonPath.stringAt('$.failure.cause.Arn'),
        buildStatus: sfn.JsonPath.stringAt('$.failure.cause.BuildStatus'),
      },
      resultPath: '$.failure',
    }).next(withBuild);

    const causeShape = new sfn.Choice(this, `${prefix}FailureCauseShape`)
      .when(
        sfn.Condition.and(
          sfn.Condition.isPresent('$.failure.cause.Build.Arn'),
          sfn.Condition.isPresent('$.failure.cause.Build.BuildStatus'),
        ),
        fromWrappedBuild,
      )
      .when(
        sfn.Condition.and(
          sfn.Condition.isPresent('$.failure.cause.Arn'),
          sfn.Condition.isPresent('$.failure.cause.BuildStatus'),
        ),
        fromBuild,
      )
      .otherwise(fallback);

    const parseCause = new sfn.Pass(this, `Parse${prefix}FailureCause`, {
      parameters: {
        cause: sfn.JsonPath.stringToJson(sfn.JsonPath.stringAt('$.error.Cause')),
      },
      resultPath: '$.failure',
    });
    parseCause.next(causeShape);

    const entry = new sfn.Choice(this, `${prefix}BuildFailureShape`)
      .when(
        sfn.Condition.and(
          sfn.Condition.stringEquals('$.error.Error', 'States.TaskFailed'),
          sfn.Condition.isPresent('$.error.Cause'),
          sfn.Condition.isNotNull('$.error.Cause'),
        ),
        parseCause,
      )
      .otherwise(fallback);
    return { entry };
  }

  /**
   * One StartBuild.sync phase with a catchable task-level timeout (§7).
   *
   * Two task variants behind a Choice on the stamped supply-chain pin
   * (T5/M10): a non-empty `$.sourceVersion` adds the CodeBuild
   * `SourceVersion` override so the build fetches exactly the pinned
   * commit; the empty string (unpinned) omits the parameter entirely —
   * CodeBuild's behaviour for an empty-string override is undefined, so it
   * is never sent. Callers wire Catch/Next on BOTH variants and route into
   * `entry`.
   */
  private buildTask(
    id: string,
    project: codebuild.Project,
    resultPath: string,
    environment: Array<Record<string, string>>,
  ): { entry: sfn.Choice; variants: sfn.CustomState[] } {
    const makeVariant = (taskId: string, withPin: boolean) =>
      new sfn.CustomState(this, taskId, {
        stateJson: {
          Type: 'Task',
          Resource: 'arn:aws:states:::codebuild:startBuild.sync',
          TimeoutSeconds: BUILD_TIMEOUT.toSeconds(),
          Parameters: {
            'ProjectName': project.projectName,
            'SourceTypeOverride.$': '$.sourceType',
            'SourceLocationOverride.$': '$.sourceLocation',
            ...(withPin ? { 'SourceVersion.$': '$.sourceVersion' } : {}),
            'BuildspecOverride': INLINE_BUILDSPEC,
            'EnvironmentVariablesOverride': environment,
          },
          ResultPath: resultPath,
        },
      });
    const unpinned = makeVariant(id, false);
    const pinned = makeVariant(`${id}Pinned`, true);
    const entry = new sfn.Choice(this, `${id}SourcePin`)
      .when(
        sfn.Condition.and(
          sfn.Condition.isPresent('$.sourceVersion'),
          sfn.Condition.not(sfn.Condition.stringEquals('$.sourceVersion', '')),
        ),
        pinned,
      )
      .otherwise(unpinned);
    return { entry, variants: [pinned, unpinned] };
  }

  /** Compare-and-set to ACTIVE + lastBuildId, conditional on the exact expected in-flight status. */ private setActiveTask(
    id: string,
    key: DynamoKey,
    expectedStatus: 'CREATING' | 'UPDATING',
    buildArnPath: string,
  ): tasks.DynamoUpdateItem {
    return this.updateItemTask(id, key, {
      updateExpression: 'SET #status = :active, lastBuildId = :buildArn, updatedAt = :now REMOVE statusReason',
      conditionExpression: 'attribute_exists(PK) AND #status = :expected',
      expressionAttributeValues: {
        ':active': attr('ACTIVE'),
        ':expected': attr(expectedStatus),
        ':buildArn': attrAt(buildArnPath),
        ':now': attrAt('$$.State.EnteredTime'),
      },
    });
  }

  /** A conditional UpdateItem with the standard terminal-write retry policy. */
  private updateItemTask(
    id: string,
    key: DynamoKey,
    props: {
      updateExpression: string;
      conditionExpression: string;
      expressionAttributeValues: Record<string, tasks.DynamoAttributeValue>;
    },
  ): tasks.DynamoUpdateItem {
    const state = new tasks.DynamoUpdateItem(this, id, {
      table: this.table,
      key,
      updateExpression: props.updateExpression,
      conditionExpression: props.conditionExpression,
      expressionAttributeNames: { '#status': 'status' },
      expressionAttributeValues: props.expressionAttributeValues,
      resultPath: sfn.JsonPath.DISCARD,
    });
    addTerminalWriteRetries(state);
    return state;
  }
}

type DynamoKey = Record<string, tasks.DynamoAttributeValue>;

/** Typed-task key for the tenant record. */
function tenantKey(): DynamoKey {
  return {
    PK: tasks.DynamoAttributeValue.fromString(
      sfn.JsonPath.format('TENANT#{}', sfn.JsonPath.stringAt('$.tenantId')),
    ),
    SK: tasks.DynamoAttributeValue.fromString('META'),
  };
}

/** Typed-task key for the cell record. */
function cellKey(): DynamoKey {
  return {
    PK: tasks.DynamoAttributeValue.fromString(
      sfn.JsonPath.format('CELL#{}', sfn.JsonPath.stringAt('$.cellId')),
    ),
    SK: tasks.DynamoAttributeValue.fromString('META'),
  };
}

/** Raw ASL key for the tenant record (aws-sdk transactWriteItems parameters). */
function rawTenantKey(): object {
  return {
    PK: { 'S.$': "States.Format('TENANT#{}', $.tenantId)" },
    SK: { S: 'META' },
  };
}

/** Raw ASL key for the cell record (aws-sdk transactWriteItems parameters). */
function rawCellKey(): object {
  return {
    PK: { 'S.$': "States.Format('CELL#{}', $.cellId)" },
    SK: { S: 'META' },
  };
}

function attr(value: string): tasks.DynamoAttributeValue {
  return tasks.DynamoAttributeValue.fromString(value);
}

/** DynamoDB string attribute resolved from a JSONPath in the state input. */
function attrAt(path: string): tasks.DynamoAttributeValue {
  return tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt(path));
}

/** DynamoDB string attribute formatted from the caught error (baseline pattern). */
function attrReason(prefix: string): tasks.DynamoAttributeValue {
  return tasks.DynamoAttributeValue.fromString(
    // The `{}` is a Step Functions States.Format placeholder, not a template literal.
    // nosemgrep: missing-template-string-indicator
    sfn.JsonPath.format(`${prefix}: {}`, sfn.JsonPath.stringAt('$.error.Error')),
  );
}

/**
 * DynamoDB string attribute naming the failed build from the normalized
 * evidence fields. Formatting only the ARN and status (never the raw Cause)
 * keeps statusReason bounded — no item bloat.
 */
function attrBuildFailureReason(prefix: string): tasks.DynamoAttributeValue {
  return tasks.DynamoAttributeValue.fromString(
    sfn.JsonPath.format(
      // The `{}` are Step Functions States.Format placeholders, not template literals.
      // nosemgrep: missing-template-string-indicator
      `${prefix}: build {} ended with status {}`,
      sfn.JsonPath.stringAt('$.failure.buildArn'),
      sfn.JsonPath.stringAt('$.failure.buildStatus'),
    ),
  );
}

/** One PLAINTEXT env var resolved from the execution input. */
function envVar(name: string, valuePath: string): Record<string, string> {
  return { 'Name': name, 'Type': 'PLAINTEXT', 'Value.$': valuePath };
}

/**
 * Terminal-write retry policy (§7 point 3): retry transient failures, but
 * never a condition failure or transaction cancellation — those are
 * definitive outcomes routed by the task's Catch.
 */
function addTerminalWriteRetries(state: { addRetry(props: sfn.RetryProps): unknown }): void {
  state.addRetry({
    errors: [
      'DynamoDB.ConditionalCheckFailedException',
      'DynamoDb.ConditionalCheckFailedException',
      'DynamoDb.TransactionCanceledException',
    ],
    maxAttempts: 0,
  });
  state.addRetry(transientRetry());
}

function transientRetry(): sfn.RetryProps {
  return {
    errors: ['States.ALL'],
    interval: Duration.seconds(2),
    backoffRate: 2,
    maxAttempts: 6,
  };
}

function ssmParameterArn(scope: Construct, path: string): string {
  return Stack.of(scope).formatArn({
    service: 'ssm',
    resource: 'parameter',
    resourceName: path.replace(/^\//, ''),
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
  });
}

function eventsRuleArn(scope: Construct, ruleName: string): string {
  return Stack.of(scope).formatArn({
    service: 'events',
    resource: 'rule',
    resourceName: ruleName,
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
  });
}

/**
 * Acknowledges the findings raised by the grants that the CodeBuild Project
 * construct generates for its own service role, plus the absence of a
 * customer-managed encryption key:
 * - AwsSolutions-IAM5 on the project's explicit CloudWatch Logs log-group
 *   (`:*` is the log-stream suffix) and report-group (`-*` is the group
 *   suffix) - both scoped to this project by construction.
 * - AwsSolutions-CB4: the projects produce no build artifacts (source and
 *   buildspec are overridden per StartBuild; output goes to CloudWatch Logs
 *   and SSM), so there is nothing for a KMS key to encrypt.
 */
function acknowledgeCodeBuildDefaults(project: codebuild.Project, logGroup: logs.ILogGroup): void {
  const stack = Stack.of(project);
  const defaultLogGroupArn = stack.formatArn({
    service: 'logs',
    resource: 'log-group',
    resourceName: `/aws/codebuild/${project.projectName}`,
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
  });
  const reportGroupArn = stack.formatArn({
    service: 'codebuild',
    resource: 'report-group',
    resourceName: `${project.projectName}-*`,
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
  });
  // The Project construct grants on the default log path regardless of the
  // explicit log group (which it grants separately, wildcard-free) — both
  // acknowledgments are kept so either grant shape stays covered.
  for (const arn of [`${defaultLogGroupArn}:*`, `${logGroup.logGroupArn}:*`]) {
    acknowledgeGranularFinding(
      project,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(project, arn)}]`,
      'CDK-generated grant on the project\'s own log group - the wildcard is the log-stream suffix.',
    );
  }
  acknowledgeGranularFinding(
    project,
    `AwsSolutions-IAM5[Resource::${nagFindingResource(project, reportGroupArn)}]`,
    'CDK-generated grant on the project\'s own report group namespace.',
  );
  Validations.of(project).acknowledge({
    id: 'AwsSolutions-CB4',
    reason: 'No build artifacts to encrypt: source and buildspec are overridden per StartBuild; output goes to CloudWatch Logs and SSM.',
  });
}

/**
 * An explicit CodeBuild project log group with bounded retention (M15,
 * threat T13): the service-created default group (`/aws/codebuild/<name>`)
 * never expires and exists outside the stack. One month keeps build output
 * (which may name tenant/cell identifiers) available for incident review
 * without indefinite accumulation.
 */
function projectLogGroup(scope: Construct, id: string): logs.LogGroup {
  const logGroup = new logs.LogGroup(scope, id, {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY, // sample only
  });
  suppressTemplateScanners(logGroup, {
    cfnNag: [{ id: 'W84', reason: 'Build logs carry provisioning script output; default CloudWatch Logs SSE encryption at rest is sufficient for this sample.' }],
    checkov: [{ id: 'CKV_AWS_158', comment: 'Build logs carry provisioning script output; default CloudWatch Logs SSE encryption at rest is sufficient for this sample.' }],
  });
  return logGroup;
}

/**
 * Acknowledges the AwsSolutions-IAM5 finding for a prefix-scoped SSM
 * parameter grant. Prefix-scoped parameter namespaces ARE the isolation
 * contract between the control plane and provisioning scripts (ADR-010):
 * the wildcard is the namespace boundary, not an over-grant.
 */
function acknowledgeSsmNamespaceGrant(scope: Construct, parameterPath: string): void {
  acknowledgeGranularFinding(
    scope,
    `AwsSolutions-IAM5[Resource::${nagFindingResource(scope, ssmParameterArn(scope, parameterPath))}]`,
    `Prefix-scoped parameter namespace '${parameterPath}' is the ADR-010 contract between the control plane and provisioning scripts - the wildcard is the namespace boundary.`,
  );
}

/** Shared application-plane resources are read-only for both roles (ADR-010). */
function readSharedResourcesStatement(scope: Construct): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'ReadSharedResources',
    actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
    resources: [ssmParameterArn(scope, '/application-plane/shared/*')],
  });
}
