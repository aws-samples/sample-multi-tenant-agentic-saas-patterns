// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as fs from 'fs';
import * as path from 'path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Validations } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { ProvisioningWorkflow } from './tenant.sfn';
import { nagFindingResource, acknowledgeGranularFinding, suppressTemplateScanners } from '../shared/nag';

export interface TenantStackProps extends StackProps {
  /** Vendor IdP OIDC issuer URL - validated by the Lambda Authorizer. */
  readonly vendorIdpIssuerUrl: string;
  /** Vendor IdP audience expected in control plane JWTs. */
  readonly vendorIdpAudience: string;
  /**
   * The deployment-configured CellDefinition (architecture.md §10,
   * ADR-012) - stamped onto each cell record at creation. Supplied via CDK
   * context and validated at synth time.
   */
  readonly cellDefinition: CellDefinition;
}

/** Where provisioning code lives - a CodeBuild ProjectSource reference. */
export interface SourceDefinition {
  /** CodeBuild source type, e.g. GITHUB, S3, CODECOMMIT. */
  readonly type: string;
  /** Source location, e.g. a git clone URL. */
  readonly location: string;
  /**
   * Optional git ref forwarded to CodeBuild StartBuild as `SourceVersion`.
   * A full 40-character commit SHA pins the provisioning source immutably
   * (threat model T5, mitigation M10) — anything else is a mutable ref and
   * triggers a synth-time warning in `main.ts`.
   */
  readonly sourceVersion?: string;
}

/** The three lifecycle script paths within the source. */
export interface ScriptLocations {
  readonly create: string;
  readonly update: string;
  readonly delete: string;
}

/**
 * The deployment-configured CellDefinition (ADR-012): one source plus two
 * script sets. Changing it affects only cells created afterwards - existing
 * cells keep their stamped definition.
 */
export interface CellDefinition {
  /** Provisioning source, stamped onto new cell records. */
  readonly source: SourceDefinition;
  /** Shared cell deployment lifecycle scripts. */
  readonly cellScripts: ScriptLocations;
  /** Per-tenant deployment lifecycle scripts. */
  readonly tenantScripts: ScriptLocations;
  /** Cell capacity, stamped at cell creation. Integer >= 1. */
  readonly maxTenants: number;
}

/** GSI-1: cell listing + per-cell tenant lookup (architecture.md §4). */
export const GSI1_NAME = 'GSI1';
/** GSI-2: unfiltered tenant listing - sparse, tenants only (§4). */
export const GSI2_NAME = 'GSI2';

/**
 * Synth-time validation of the cellDefinition deployment input (§10):
 * `maxTenants` must be an integer of at least one; source and every script
 * value must be non-empty. Throws with a clear message otherwise.
 */
export function validateCellDefinition(definition: CellDefinition): void {
  const problems: string[] = [];
  const requireNonEmpty = (name: string, value: unknown) => {
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`${name} must be a non-empty string`);
    }
  };

  requireNonEmpty('cellDefinition.source.type', definition?.source?.type);
  requireNonEmpty('cellDefinition.source.location', definition?.source?.location);
  for (const scriptSet of ['cellScripts', 'tenantScripts'] as const) {
    for (const operation of ['create', 'update', 'delete'] as const) {
      requireNonEmpty(`cellDefinition.${scriptSet}.${operation}`, definition?.[scriptSet]?.[operation]);
    }
  }
  if (!Number.isInteger(definition?.maxTenants) || definition.maxTenants < 1) {
    problems.push(`cellDefinition.maxTenants must be an integer >= 1 (got: ${JSON.stringify(definition?.maxTenants)})`);
  }

  if (problems.length > 0) {
    throw new Error(
      'Invalid cellDefinition deployment input (architecture.md §10):\n'
      + problems.map((p) => `  - ${p}`).join('\n')
      + '\nSupply it via CDK context, e.g. cdk.json or --context cellDefinition=\'{"source":{"type":"GITHUB","location":"https://..."},"cellScripts":{"create":"...","update":"...","delete":"..."},"tenantScripts":{"create":"...","update":"...","delete":"..."},"maxTenants":10}\'',
    );
  }
}

/**
 * The cell-based control plane - one stack: API Gateway (generated from the
 * Smithy OpenAPI output), Lambda Authorizer (vendor IdP), API handler, the
 * cells + tenants table (GSI-1/GSI-2), and the provisioning workflow
 * (architecture.md §3).
 */
export class TenantStack extends Stack {
  /** The provisioning workflow (exposed so tests can grant script-source access). */
  readonly provisioning: ProvisioningWorkflow;
  /** The deployed API base URL (with trailing slash). */
  readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: TenantStackProps) {
    super(scope, id, props);

    // Fail synth on an invalid cellDefinition (§10).
    validateCellDefinition(props.cellDefinition);

    // --- Control plane table (cells + tenants, single table) --------------
    // PK=CELL#<id>|TENANT#<id>, SK=META. GSI-1/GSI-2 serve the three listing
    // patterns (§4); both project ALL attributes - the placement candidate
    // scan needs status/tenantCount/maxTenants, and both listings return
    // full summaries. GSI-2 is sparse (tenants only). The GSIs are
    // eventually consistent and never authoritative - tenantCount on the
    // cell record is the occupancy guard (§6).
    const table = new dynamodb.TableV2(this, 'TenantTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      globalSecondaryIndexes: [
        {
          indexName: GSI1_NAME,
          partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
        {
          indexName: GSI2_NAME,
          partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
          projectionType: dynamodb.ProjectionType.ALL,
        },
      ],
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Garbage-collects CreateTenant idempotency records (ADR-017). TTL
      // deletion is lazy, so tokens are honoured for AT LEAST 24h — replay
      // handling never reads expiresAt.
      timeToLiveAttribute: 'expiresAt',
      // Sample only - a production control plane retains its tenant registry.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- Provisioning workflow (Step Functions + two shared CodeBuild
    //     projects with distinct service roles, §3/§7) ---------------------
    // The workflow grants itself least-privilege table access internally.
    const workflow = new ProvisioningWorkflow(this, 'Provisioning', { table });
    this.provisioning = workflow;

    // --- Lambda Authorizer (the ingress layer) ----------------------------
    const authorizerFn = new NodejsFunction(this, 'AuthorizerFunction', {
      entry: path.join(__dirname, '../shared/authorizer.function.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      bundling: {
        externalModules: [], // bundle everything - see ApiFunction note
      },
      // M15 (T13): explicit log group with bounded retention — the
      // Lambda-service-created default group never expires.
      logGroup: functionLogGroup(this, 'AuthorizerFunctionLogs'),
      environment: {
        VENDOR_IDP_ISSUER_URL: props.vendorIdpIssuerUrl,
        VENDOR_IDP_AUDIENCE: props.vendorIdpAudience,
        // M13 (T2/T20): the role allowlist the authorizer enforces on the
        // JWT `role` claim. 'operator' is also the code's default when
        // unset — wiring it here makes the enforcement configuration
        // visible at the deployment surface.
        ALLOWED_ROLES: 'operator',
      },
    });
    acknowledgeLambdaBasicExecutionRole(authorizerFn);

    // --- API handler (pass-through to the Smithy service handler) ---------
    const apiFn = new NodejsFunction(this, 'ApiFunction', {
      entry: path.join(__dirname, 'tenant.function.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      // M15 (T13) — see AuthorizerFunction.
      logGroup: functionLogGroup(this, 'ApiFunctionLogs'),
      bundling: {
        // Bundle everything. The default externalModules treats @smithy/* as
        // provided by the Lambda runtime, but the runtime SDK does NOT ship
        // the Smithy *server* packages (@smithy/server-apigateway,
        // @smithy/server-common) - relying on externals 502s at cold start.
        externalModules: [],
        // The SSDK's generated validators use re2-wasm, which loads its wasm
        // binary from disk at runtime - esbuild does not bundle it.
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp ${inputDir}/node_modules/re2-wasm/build/wasm/re2.wasm ${outputDir}/`,
          ],
        },
      },
      environment: {
        TABLE_NAME: table.tableName,
        GSI1_NAME: GSI1_NAME,
        GSI2_NAME: GSI2_NAME,
        STATE_MACHINE_ARN: workflow.stateMachine.stateMachineArn,
        // The deployment-configured CellDefinition (§10) - stamped onto new
        // cell records by the placement path; validated at synth time.
        CELL_DEFINITION: JSON.stringify(props.cellDefinition),
        CELL_PROJECT_NAME: workflow.cellProject.projectName,
        TENANT_PROJECT_NAME: workflow.tenantProject.projectName,
      },
    });
    table.grantReadWriteData(apiFn);
    workflow.stateMachine.grantStartExecution(apiFn);
    acknowledgeLambdaBasicExecutionRole(apiFn);
    acknowledgeGranularFinding(
      apiFn,
      `AwsSolutions-IAM5[Resource::${nagFindingResource(this, `${table.tableArn}/index/*`)}]`,
      'grantReadWriteData grants Query on the table\'s own GSIs - the wildcard is scoped to this table\'s index namespace, not across resources.',
    );

    // --- API Gateway from the Smithy-generated OpenAPI spec ---------------
    // Never hand-crafted: the spec is generated by `smithy build`; only the
    // PLACEHOLDER URIs (authorizer + integrations) are patched at synth time.
    const apiAccessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY, // sample only
    });
    const api = new apigateway.SpecRestApi(this, 'Api', {
      apiDefinition: apigateway.ApiDefinition.fromInline(
        patchOpenApiSpec(this, authorizerFn.functionArn, apiFn.functionArn),
      ),
      deployOptions: {
        stageName: 'prod',
        // Who called the API and how (AwsSolutions-APIG1). M12 (T9): the
        // custom JSON format adds the authorizer principalId — the verified
        // JWT `sub` — so every logged request, INCLUDING denied ones, is
        // attributable to an operator. jsonWithStandardFields() omits it.
        accessLogDestination: new apigateway.LogGroupLogDestination(apiAccessLogs),
        accessLogFormat: apigateway.AccessLogFormat.custom(JSON.stringify({
          requestId: apigateway.AccessLogField.contextRequestId(),
          ip: apigateway.AccessLogField.contextIdentitySourceIp(),
          requestTime: apigateway.AccessLogField.contextRequestTime(),
          httpMethod: apigateway.AccessLogField.contextHttpMethod(),
          resourcePath: apigateway.AccessLogField.contextResourcePath(),
          status: apigateway.AccessLogField.contextStatus(),
          protocol: apigateway.AccessLogField.contextProtocol(),
          responseLength: apigateway.AccessLogField.contextResponseLength(),
          // The operator identity: the authorizer's principalId (JWT sub),
          // present on Allow AND Deny — the audit chain's first link.
          operatorId: apigateway.AccessLogField.contextAuthorizerPrincipalId(),
        })),
        // Execution logging for every method (AwsSolutions-APIG6).
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        // X-Ray tracing (CKV_AWS_73) - completes the trace path that the
        // provisioning state machine already participates in.
        tracingEnabled: true,
        // Explicit stage throttling: CreateTenant/UpdateResource start
        // CodeBuild builds, so a leaked token is a cost-amplification
        // vector. Modest sample-appropriate limits; tune for real fleets.
        throttlingRateLimit: 20,
        throttlingBurstLimit: 40,
      },
    });
    this.apiUrl = api.url;

    // M17 (T16): sustained client errors are the probing / leaked-token /
    // amplification-attempt signature at the API edge. Alarm only (no
    // actions) — sample scope surfaces the signal.
    new cloudwatch.Alarm(this, 'ApiClientErrorAlarm', {
      metric: api.metricClientError({
        period: Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 50,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'More than 50 4XX responses in 5 minutes - possible token probing or amplification attempt (threat T16, mitigation M17).',
    });
    acknowledgeGranularFinding(
      api,
      'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs]',
      'The canonical AWS policy for API Gateway\'s account-level CloudWatch logging role - required for stage execution logging (APIG6).',
    );
    Validations.of(api).acknowledge({
      id: 'AwsSolutions-APIG2',
      reason: 'Request validation IS enabled: the Smithy model applies @requestValidator("full"), embedded in the OpenAPI definition. The rule only detects standalone CfnRequestValidator resources, which SpecRestApi does not create.',
    });
    Validations.of(api).acknowledge({
      id: 'AwsSolutions-APIG3',
      reason: 'WAFv2 association is a production deployment concern outside this sample\'s scope - the stage is protected by the Lambda Authorizer and explicit throttling limits.',
    });
    suppressTemplateScanners(apiAccessLogs, {
      cfnNag: [{ id: 'W84', reason: 'Access logs carry request metadata only; default CloudWatch Logs SSE encryption at rest is sufficient for this sample.' }],
      checkov: [{ id: 'CKV_AWS_158', comment: 'Access logs carry request metadata only; default CloudWatch Logs SSE encryption at rest is sufficient for this sample.' }],
    });
    suppressTemplateScanners(api.deploymentStage, {
      cfnNag: [{ id: 'W64', reason: 'The API is not usage-plan/API-key based: callers authenticate with vendor-IdP JWTs via the Lambda Authorizer, and explicit stage throttling bounds request rates.' }],
      checkov: [{ id: 'CKV_AWS_120', comment: 'Control-plane responses are per-caller and mutation-heavy; stage caching risks stale reads for marginal benefit.' }],
    });
    if (api.latestDeployment !== undefined) {
      suppressTemplateScanners(api.latestDeployment, {
        cfnNag: [{ id: 'W68', reason: 'The API is not usage-plan/API-key based: callers authenticate with vendor-IdP JWTs via the Lambda Authorizer, and explicit stage throttling bounds request rates.' }],
      });
    }
    // Least-privilege policies with granular per-namespace statements push
    // the SPCM metric past cfn_nag's threshold - explicit scoping, not
    // over-breadth.
    suppressTemplateScanners(apiFn.role!.node.findChild('DefaultPolicy'), {
      cfnNag: [{ id: 'W76', reason: 'Least-privilege policy with granular per-resource statements (table, GSIs, state machine, idempotency); the statement-point count reflects explicit scoping, not over-breadth.' }],
    });

    // API Gateway must be allowed to invoke both functions.
    apiFn.addPermission('ApiGatewayInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: api.arnForExecuteApi(),
    });
    authorizerFn.addPermission('ApiGatewayAuthorizerInvoke', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: Stack.of(this).formatArn({
        service: 'execute-api',
        resource: api.restApiId,
        resourceName: 'authorizers/*',
      }),
    });

    // --- Discovery + outputs ----------------------------------------------
    new ssm.StringParameter(this, 'ApiUrlParameter', {
      parameterName: '/control-plane/tenant-api-url',
      stringValue: api.url,
    });

    // DEMO ONLY: stands in for application-plane shared infrastructure
    // (ADR-010). In a real deployment the application plane publishes its own
    // shared resource identifiers - the control plane is not involved.
    new ssm.StringParameter(this, 'DemoSharedBaseDomain', {
      parameterName: '/application-plane/shared/base-domain',
      stringValue: 'silo.example.com',
    });

    new CfnOutput(this, 'ApiUrl', { value: api.url });
    new CfnOutput(this, 'StateMachineArn', { value: workflow.stateMachine.stateMachineArn });
  }
}

/**
 * Acknowledges the AwsSolutions-IAM4 finding for the AWSLambdaBasicExecutionRole
 * managed policy that NodejsFunction attaches to every function's service role.
 */
function acknowledgeLambdaBasicExecutionRole(fn: NodejsFunction): void {
  acknowledgeGranularFinding(
    fn,
    'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
    'Logs-only managed policy attached by NodejsFunction; a scoped customer-managed replacement adds boilerplate with marginal benefit.',
  );
  // Template-scanner (cfn_nag/checkov) counterparts of the deliberate
  // deviations above - annotated on the resources so scans of the
  // synthesized templates (e.g. the committed integ snapshot) see the
  // same documented decisions.
  suppressTemplateScanners(fn, {
    cfnNag: [
      { id: 'W58', reason: 'Log permissions come from the AWSLambdaBasicExecutionRole managed policy on the function role; cfn_nag does not resolve managed policies.' },
      { id: 'W89', reason: 'The function calls only AWS APIs over public endpoints; there are no VPC-internal resources to reach. VPC placement adds cost and complexity without a security benefit here.' },
      { id: 'W92', reason: 'The sample does not partition account concurrency; API Gateway stage throttling bounds the invoke rate.' },
    ],
    checkov: [
      { id: 'CKV_AWS_115', comment: 'The sample does not partition account concurrency; API Gateway stage throttling bounds the invoke rate.' },
      { id: 'CKV_AWS_116', comment: 'Synchronous API/authorizer function - failures surface to the caller as HTTP errors; there is no async event source to dead-letter.' },
      { id: 'CKV_AWS_117', comment: 'The function calls only AWS APIs over public endpoints; there are no VPC-internal resources to reach.' },
      { id: 'CKV_AWS_173', comment: 'Environment variables carry non-secret configuration (table/project names, ARNs, public IdP values); default encryption at rest applies.' },
    ],
  });
  // Newer feature flags give the function an owned LogGroup child; older
  // apps rely on the Lambda-service-created group (no CFN resource).
  // (fn.logGroup returns an imported wrapper, so target the child directly.)
  const ownedLogGroup = fn.node.tryFindChild('LogGroup');
  if (ownedLogGroup !== undefined) {
    suppressTemplateScanners(ownedLogGroup, {
      cfnNag: [{ id: 'W84', reason: 'Function logs carry non-sensitive request metadata; default CloudWatch Logs SSE encryption at rest is sufficient for this sample.' }],
      checkov: [{ id: 'CKV_AWS_158', comment: 'Function logs carry non-sensitive request metadata; default CloudWatch Logs SSE encryption at rest is sufficient for this sample.' }],
    });
  }
}

/**
 * An explicit Lambda function log group with bounded retention (M15,
 * threat T13): the Lambda-service-created default group never expires and
 * exists outside the stack. One month matches the other control plane log
 * groups (API access logs, workflow logs, build logs).
 */
function functionLogGroup(scope: Construct, id: string): logs.LogGroup {
  const logGroup = new logs.LogGroup(scope, id, {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY, // sample only
  });
  suppressTemplateScanners(logGroup, {
    cfnNag: [{ id: 'W84', reason: 'Function logs carry non-sensitive request metadata; default CloudWatch Logs SSE encryption at rest is sufficient for this sample.' }],
    checkov: [{ id: 'CKV_AWS_158', comment: 'Function logs carry non-sensitive request metadata; default CloudWatch Logs SSE encryption at rest is sufficient for this sample.' }],
  });
  return logGroup;
}

/**
 * Loads the generated OpenAPI spec and patches the two PLACEHOLDER kinds:
 * - the token authorizer's `authorizerUri` → the authorizer Lambda
 * - every operation's `x-amazon-apigateway-integration.uri` → the API Lambda
 */
function patchOpenApiSpec(stack: Stack, authorizerFnArn: string, apiFnArn: string): object {
  const specPath = path.join(
    __dirname,
    '../smithy/source/openapi/TenantService.openapi.json',
  );
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

  const invocationUri = (fnArn: string) =>
    `arn:${stack.partition}:apigateway:${stack.region}:lambda:path/2015-03-31/functions/${fnArn}/invocations`;

  for (const scheme of Object.values(spec.components?.securitySchemes ?? {}) as any[]) {
    if (scheme['x-amazon-apigateway-authorizer']?.authorizerUri === 'PLACEHOLDER') {
      scheme['x-amazon-apigateway-authorizer'].authorizerUri = invocationUri(authorizerFnArn);
    }
  }
  for (const pathItem of Object.values(spec.paths ?? {}) as any[]) {
    for (const operation of Object.values(pathItem) as any[]) {
      const integration = operation['x-amazon-apigateway-integration'];
      if (integration?.uri === 'PLACEHOLDER') {
        integration.uri = invocationUri(apiFnArn);
      }
    }
  }
  return spec;
}
