// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as path from 'path';
import { ExpectedResult, IntegTest } from '@aws-cdk/integ-tests-alpha';
import { App, Aspects, CfnResource, Duration, IAspect, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { ApplicationLogLevel } from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { WriteNagSuppressionsToCloudFormationAspect } from 'cdk-nag';
import { IConstruct } from 'constructs';
import { suppressTemplateScanners } from '../src/shared/nag';
import { CellDefinition, TenantStack } from '../src/tenant/tenant.cdk';

/**
 * End-to-end integration test for the cell-based control plane
 * (architecture.md §11, workstream F).
 *
 * Setup: a throwaway Cognito user pool acts as the vendor IdP (its ID tokens
 * carry iss + aud, which the authorizer validates via OIDC discovery, plus
 * the `role: "operator"` claim ADR-018 requires, added by a pre token
 * generation trigger), and
 * the sample cell + tenant scripts are hosted in an S3 bucket used as the
 * stamped CodeBuild ProjectSource. maxTenants = 2 so filling a cell is cheap.
 *
 * Flow (every API operation is exercised):
 *   1. unauthenticated request → 401
 *   2. mint an operator: adminCreateUser → adminSetUserPassword →
 *      adminInitiateAuth → ID token
 *   3. CreateTenant #1 (202, includes cellId) → poll GetTenant until ACTIVE
 *      (cell create build + tenant create build ran); exactly one cell,
 *      ACTIVE, 1/2 occupied; the cell namespace and tenant parameter exist
 *   4. CreateTenant #2 (with clientToken) → same cell (reuse before create);
 *      cell now 2/2; replaying the identical request returns the SAME tenant
 *      (already ACTIVE — no duplicate onboard, ADR-017); reusing the token
 *      with different parameters → 409; still exactly one cell at 2/2
 *   5. CreateTenant #3 → NEW cell (first cell full); two cells;
 *      an in-flight DeleteTenant on #3 while CREATING → 409
 *   6. GetResource resolves the stamped definition; ListTenants?cellId=
 *      returns exactly the cell's tenants; unknown cellId → empty page
 *   7. UpdateTenant (metadata, 200, reflected); UpdateResource (202) → ACTIVE
 *   8. UpdateCell (202) → poll GetCell until ACTIVE again
 *   9. DeleteCell on the occupied cell → 409 (ADR-014)
 *  10. DeleteTenant #1 (202) → poll until 404; slot freed (1/2); tenant
 *      parameter gone
 *  11. DeleteTenant #2 and #3 → poll until 404; tenant namespace empty
 *  12. DeleteCell both cells (202) → poll GetCell until 404; no cells left;
 *      the cell SSM namespaces are empty
 *
 * Run with the single-Region command documented in README.md under
 * "Deployment integration test" (deploys real infrastructure).
 */

const app = new App();

// --- Setup stack: vendor IdP + script source -------------------------------
const setup = new Stack(app, 'control-plane-integ-setup');

const vendorIdp = new cognito.UserPool(setup, 'VendorIdp', {
  selfSignUpEnabled: false,
  removalPolicy: RemovalPolicy.DESTROY,
});
// ADR-018 deployment contract: the vendor IdP must mint `role: "operator"`
// on operator tokens - the authorizer fails closed on a missing role. A
// plain Cognito ID token carries no such claim, so this pre token
// generation trigger (V1_0 event, ID token only) adds it, exactly as a real
// vendor IdP would be configured to.
const mintOperatorRole = new lambda.Function(setup, 'MintOperatorRole', {
  runtime: lambda.Runtime.NODEJS_24_X,
  handler: 'index.handler',
  code: lambda.Code.fromInline(`
    exports.handler = async (event) => {
      event.response = {
        claimsOverrideDetails: {
          claimsToAddOrOverride: { role: 'operator' },
        },
      };
      return event;
    };
  `),
});
vendorIdp.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION, mintOperatorRole);
const idpClient = vendorIdp.addClient('IntegOperatorClient', {
  authFlows: { adminUserPassword: true },
  generateSecret: false,
});

const scriptsBucket = new s3.Bucket(setup, 'LifecycleScripts', {
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  encryption: s3.BucketEncryption.S3_MANAGED,
  enforceSSL: true,
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});
suppressTemplateScanners(scriptsBucket, {
  cfnNag: [
    { id: 'W35', reason: 'Ephemeral integ-test script source, auto-deleted on teardown; access logging adds no value for a short-lived test artifact.' },
  ],
  checkov: [
    { id: 'CKV_AWS_18', comment: 'Ephemeral integ-test script source, auto-deleted on teardown; access logging adds no value for a short-lived test artifact.' },
    { id: 'CKV_AWS_21', comment: 'Ephemeral integ-test script source, auto-deleted on teardown; versioning adds no value for a short-lived test artifact.' },
  ],
});
new s3deploy.BucketDeployment(setup, 'DeployCellScripts', {
  destinationBucket: scriptsBucket,
  destinationKeyPrefix: 'scripts/sample-cell',
  sources: [s3deploy.Source.asset(path.join(__dirname, '../scripts/sample-cell'))],
});
new s3deploy.BucketDeployment(setup, 'DeployTenantScripts', {
  destinationBucket: scriptsBucket,
  destinationKeyPrefix: 'scripts/sample-tenant',
  sources: [s3deploy.Source.asset(path.join(__dirname, '../scripts/sample-tenant'))],
});

// --- Stack under test -------------------------------------------------------
// The deployment-configured CellDefinition (§10) — stamped onto every cell
// this test creates. maxTenants = 2 keeps fill-to-capacity cheap.
const cellDefinition: CellDefinition = {
  source: { type: 'S3', location: `${scriptsBucket.bucketName}/scripts/` },
  cellScripts: {
    create: 'sample-cell/create.sh',
    update: 'sample-cell/update.sh',
    delete: 'sample-cell/delete.sh',
  },
  tenantScripts: {
    create: 'sample-tenant/create.sh',
    update: 'sample-tenant/update.sh',
    delete: 'sample-tenant/delete.sh',
  },
  maxTenants: 2,
};

const stack = new TenantStack(app, 'control-plane-integ', {
  vendorIdpIssuerUrl: vendorIdp.userPoolProviderUrl,
  vendorIdpAudience: idpClient.userPoolClientId,
  cellDefinition,
});
// Both shared CodeBuild projects pull the stamped source from the test bucket.
scriptsBucket.grantRead(stack.provisioning.cellProject);
scriptsBucket.grantRead(stack.provisioning.tenantProject);

// --- Assertions --------------------------------------------------------------
const integ = new IntegTest(app, 'ControlPlaneInteg', {
  testCases: [stack],
  // INFO makes the assertion provider log each request/response to
  // CloudWatch - invaluable when an ApiCall attribute fails to resolve.
  providerLogLevel: ApplicationLogLevel.INFO,
  cdkCommandOptions: { destroy: { args: { force: true } } },
});

// Template-scanner (cfn_nag/checkov) annotations for CDK-owned constructs
// this test does not author: the setup stack's custom-resource providers
// (S3 auto-delete, BucketDeployment) and the integ-tests-alpha assertion
// harness. The stack under test carries targeted annotations in source
// instead, so it is deliberately excluded here.
const HARNESS_REASON =
  'CDK-managed custom resource provider / integ-test assertion harness - test scaffolding, not part of the sample\'s deployable surface.';
class HarnessScannerSuppressions implements IAspect {
  public visit(node: IConstruct): void {
    if (!CfnResource.isCfnResource(node) || Stack.of(node) === stack) {
      return;
    }
    switch (node.cfnResourceType) {
      case 'AWS::Lambda::Function':
        suppressTemplateScanners(node, {
          cfnNag: ['W58', 'W89', 'W92'].map((id) => ({ id, reason: HARNESS_REASON })),
          checkov: ['CKV_AWS_115', 'CKV_AWS_116', 'CKV_AWS_117', 'CKV_AWS_173'].map(
            (id) => ({ id, comment: HARNESS_REASON }),
          ),
        });
        break;
      case 'AWS::Logs::LogGroup':
        suppressTemplateScanners(node, {
          cfnNag: [{ id: 'W84', reason: HARNESS_REASON }],
          checkov: [{ id: 'CKV_AWS_158', comment: HARNESS_REASON }],
        });
        break;
      case 'AWS::IAM::Policy':
      case 'AWS::IAM::Role':
        suppressTemplateScanners(node, {
          cfnNag: ['W11', 'W12', 'W28', 'W76'].map((id) => ({ id, reason: HARNESS_REASON })),
          checkov: ['CKV_AWS_107', 'CKV_AWS_108', 'CKV_AWS_109', 'CKV_AWS_110', 'CKV_AWS_111'].map(
            (id) => ({ id, comment: HARNESS_REASON }),
          ),
        });
        break;
    }
  }
}
Aspects.of(app).add(new HarnessScannerSuppressions());

// The integ app does not run the AwsSolutionsChecks plugin (the harness
// stacks are not held to the sample's rule pack), but the stack under test
// records its cdk-nag acknowledgments either way - this aspect copies them
// into the synthesized templates as cdk_nag.rules_to_suppress Metadata so
// the audit trail is visible in the committed snapshot (mirrors
// writeSuppressionsToCloudFormation in src/main.ts).
Aspects.of(app).add(new WriteNagSuppressionsToCloudFormationAspect());

const adminEmail = 'success+integ-operator@simulator.amazonses.com';
const apiUrl = stack.apiUrl;

// Polling budgets: onboarding into a NEW cell runs two CodeBuild builds in
// one execution (cell create, then tenant create) — roughly twice the silo
// budget. Single-build operations keep the original 15-minute budget.
const newCellPoll = {
  totalTimeout: Duration.minutes(30),
  interval: Duration.seconds(30),
};
const singleBuildPoll = {
  totalTimeout: Duration.minutes(15),
  interval: Duration.seconds(30),
};

// A syntactically valid ULID that no cell will ever have — the unknown-cell
// listing must yield an empty page, not a 404 (§5).
const unknownCellId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const ssmReadPolicy = {
  Effect: 'Allow',
  Action: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
  Resource: ['*'],
};

// 1. No vendor JWT → API Gateway rejects before any Lambda runs.
integ.assertions
  .httpApiCall(`${apiUrl}tenants`, { method: 'GET' })
  .expect(ExpectedResult.objectLike({ status: 401 }));

// 2. Mint an operator identity in the vendor IdP.
const cognitoPolicy = {
  Effect: 'Allow',
  Action: [
    'cognito-idp:AdminCreateUser',
    'cognito-idp:AdminSetUserPassword',
    'cognito-idp:AdminInitiateAuth',
  ],
  Resource: ['*'],
};

const createUser = integ.assertions.awsApiCall('cognito-identity-provider', 'adminCreateUser', {
  UserPoolId: vendorIdp.userPoolId,
  Username: adminEmail,
  MessageAction: 'SUPPRESS',
});
createUser.provider.addToRolePolicy(cognitoPolicy);

// Generate the operator's password at run time — never a committed literal
// (the synthesized snapshot carries only a Fn::GetAtt reference). The
// throwaway credential lives exactly as long as the assertion stack.
const randomPassword = integ.assertions.awsApiCall('secrets-manager', 'getRandomPassword', {
  PasswordLength: 32,
  RequireEachIncludedType: true,
  // The assertion provider splices this value into JSON-encoded call
  // parameters at synth time (Fn::Join around the Fn::GetAtt) - a quote or
  // backslash in the password would corrupt that encoding, so keep them
  // (and shell-sensitive quotes) out of the generated password.
  ExcludeCharacters: '"\'\\`',
});
randomPassword.provider.addToRolePolicy({
  Effect: 'Allow',
  Action: ['secretsmanager:GetRandomPassword'],
  Resource: ['*'],
});
const password = randomPassword.getAttString('RandomPassword');

const setPassword = integ.assertions.awsApiCall('cognito-identity-provider', 'adminSetUserPassword', {
  UserPoolId: vendorIdp.userPoolId,
  Username: adminEmail,
  Password: password,
  Permanent: true,
});
setPassword.provider.addToRolePolicy(cognitoPolicy);

const authenticate = integ.assertions.awsApiCall(
  'cognito-identity-provider',
  'adminInitiateAuth',
  {
    UserPoolId: vendorIdp.userPoolId,
    ClientId: idpClient.userPoolClientId,
    AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: adminEmail, PASSWORD: password },
  },
  // Only the ID token - the full AuthenticationResult (three JWTs) exceeds
  // the 4KB custom resource data limit once flattened.
  ['AuthenticationResult.IdToken'],
);
authenticate.provider.addToRolePolicy(cognitoPolicy);

// The vendor IdP ID token: aud = client id, iss = the pool's issuer URL.
const token = authenticate.getAttString('AuthenticationResult.IdToken');
const authHeaders = {
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json',
};

// 3. Onboard tenant #1 — CreateTenant carries no resource definition (§5):
//    placement creates the first cell implicitly and returns the tenant
//    CREATING with its cellId.
const createTenant1 = integ.assertions.httpApiCall(`${apiUrl}tenants`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({
    name: 'integ-tenant-1',
    description: 'created by the integ test',
    adminEmail: 'success+integ-tenant-1@simulator.amazonses.com',
  }),
});
// Note: no .expect() here - combining expect() with getAttString() on the
// same HttpApiCall is unsupported (response flattening breaks the internal
// assertion path). The 202/CREATING contract is implicitly verified by the
// ACTIVE poll below, which can only succeed if creation started.
const tenantId1 = createTenant1.getAttString('body.tenant.tenantId');
const cellId1 = createTenant1.getAttString('body.tenant.cellId');

// Poll until the cell create build AND the tenant create build have run
// (one workflow execution, two builds — hence the doubled budget).
const waitForActive1 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { status: 'ACTIVE' } } }))
  .waitForAssertions(newCellPoll);

// Exactly one cell: ACTIVE, one of two slots occupied. The plain array in
// the pattern is matched exact-length, element-wise (deep-partial per
// element) — one element asserts "exactly one cell".
const listCellsOne = integ.assertions
  .httpApiCall(`${apiUrl}cells`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { cells: [{ cellId: cellId1, status: 'ACTIVE', tenantCount: 1, maxTenants: 2 }] },
    }),
  );

// GetCell returns the stamped definition (ADR-012).
const getCell1 = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId1}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: {
        cell: {
          cellId: cellId1,
          status: 'ACTIVE',
          tenantCount: 1,
          maxTenants: 2,
          source: cellDefinition.source,
          cellScripts: cellDefinition.cellScripts,
          tenantScripts: cellDefinition.tenantScripts,
        },
      },
    }),
  );

// The cell's shared deployment published its namespace (the cell → tenant
// contract, §7) …
const checkCellParam = integ.assertions.awsApiCall('SSM', 'getParameter', {
  Name: `/application-plane/cells/${cellId1}/shared-endpoint`,
});
checkCellParam.provider.addToRolePolicy(ssmReadPolicy);
checkCellParam.expect(ExpectedResult.objectLike({ Parameter: { Type: 'String' } }));

// … and the tenant create script provisioned the per-tenant deployment.
const checkTenantParam1 = integ.assertions.awsApiCall('SSM', 'getParameter', {
  Name: `/application-plane/tenants/${tenantId1}`,
});
checkTenantParam1.provider.addToRolePolicy(ssmReadPolicy);
checkTenantParam1.expect(ExpectedResult.objectLike({ Parameter: { Type: 'String' } }));

// 4. Onboard tenant #2 — placement must REUSE cell #1 (reuse before create,
//    §6): the ACTIVE poll pins the cellId to cell #1. Carries a clientToken
//    so the replay below can exercise CreateTenant idempotency (ADR-017).
const clientToken2 = 'integ-retry-token-tenant-2';
const createTenant2Body = JSON.stringify({
  name: 'integ-tenant-2',
  adminEmail: 'success+integ-tenant-2@simulator.amazonses.com',
  clientToken: clientToken2,
});
const createTenant2 = integ.assertions.httpApiCall(`${apiUrl}tenants`, {
  method: 'POST',
  headers: authHeaders,
  body: createTenant2Body,
});
const tenantId2 = createTenant2.getAttString('body.tenant.tenantId');

const waitForActive2 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { tenant: { status: 'ACTIVE', cellId: cellId1 } },
    }),
  )
  .waitForAssertions(singleBuildPoll);

// Replay the IDENTICAL request (same clientToken, same parameters): the
// original tenant comes back — same tenantId, and already ACTIVE, which a
// fresh onboard could never be (it would start CREATING). No new tenant,
// no new build (ADR-017).
const replayCreateTenant2 = integ.assertions
  .httpApiCall(`${apiUrl}tenants`, {
    method: 'POST',
    headers: authHeaders,
    body: createTenant2Body,
  })
  .expect(
    ExpectedResult.objectLike({
      status: 202,
      body: { tenant: { tenantId: tenantId2, cellId: cellId1, status: 'ACTIVE' } },
    }),
  );

// Reusing the token with DIFFERENT parameters is a request-hash mismatch → 409.
const reuseTokenMismatch = integ.assertions
  .httpApiCall(`${apiUrl}tenants`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      name: 'integ-tenant-2-different',
      adminEmail: 'success+integ-tenant-2@simulator.amazonses.com',
      clientToken: clientToken2,
    }),
  })
  .expect(ExpectedResult.objectLike({ status: 409 }));

// Still exactly one cell — now full (2/2). Sequenced AFTER the replay and
// the mismatch: neither may have claimed a slot or created a cell.
const listCellsStillOne = integ.assertions
  .httpApiCall(`${apiUrl}cells`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { cells: [{ cellId: cellId1, status: 'ACTIVE', tenantCount: 2, maxTenants: 2 }] },
    }),
  );

// 5. Onboard tenant #3 — cell #1 is full, so placement creates a NEW cell.
const createTenant3 = integ.assertions.httpApiCall(`${apiUrl}tenants`, {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({
    name: 'integ-tenant-3',
    adminEmail: 'success+integ-tenant-3@simulator.amazonses.com',
  }),
});
const tenantId3 = createTenant3.getAttString('body.tenant.tenantId');
const cellId3 = createTenant3.getAttString('body.tenant.cellId');

// In-flight guard: tenant #3 is CREATING (its cell + tenant builds take
// minutes; this call fires within seconds) — a mutation must 409 (§5).
const deleteWhileCreating = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId3}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 409 }));

const waitForActive3 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId3}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { status: 'ACTIVE' } } }))
  .waitForAssertions(newCellPoll);

// Two cells now: cell #1 untouched at 2/2 (proving tenant #3 did NOT land
// there), the new cell at 1/2. ULIDs are time-ordered, so cell #1 sorts
// first; cellId3 pins the second element to tenant #3's placement.
const listCellsTwo = integ.assertions
  .httpApiCall(`${apiUrl}cells`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: {
        cells: [
          { cellId: cellId1, status: 'ACTIVE', tenantCount: 2, maxTenants: 2 },
          { cellId: cellId3, status: 'ACTIVE', tenantCount: 1, maxTenants: 2 },
        ],
      },
    }),
  );

// 6. GetResource resolves source + scripts from the cell's stamped
//    definition (the cell's tenantScripts) and names the cell (§5).
const getResource1 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/resource`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: {
        status: 'ACTIVE',
        cellId: cellId1,
        source: cellDefinition.source,
        scripts: cellDefinition.tenantScripts,
      },
    }),
  );

// ListTenants?cellId= — exactly the cell's tenants (ULID order: #1, #2).
const listTenantsByCell1 = integ.assertions
  .httpApiCall(`${apiUrl}tenants?cellId=${cellId1}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { tenants: [{ tenantId: tenantId1, cellId: cellId1 }, { tenantId: tenantId2, cellId: cellId1 }] },
    }),
  );

// An unknown cellId is a query predicate miss — empty page, not a 404 (§5).
const listTenantsUnknownCell = integ.assertions
  .httpApiCall(`${apiUrl}tenants?cellId=${unknownCellId}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenants: [] } }));

// 7. Updates: metadata (sync 200, reflected in GetTenant), then re-apply the
//    tenant deployment (202 → ACTIVE again).
const updateTenant1 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, {
    method: 'PUT',
    headers: authHeaders,
    body: JSON.stringify({ description: 'updated by the integ test' }),
  })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { status: 'ACTIVE' } } }));

const getTenant1Updated = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { tenant: { description: 'updated by the integ test' } },
    }),
  );

const updateResource1 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}/resource`, { method: 'PUT', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { tenant: { status: 'UPDATING' } } }));

const waitForTenant1Updated = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { tenant: { status: 'ACTIVE' } } }))
  .waitForAssertions(singleBuildPoll);

// 8. Re-apply the shared cell deployment (202 → GetCell polls back to ACTIVE).
const updateCell1 = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId1}`, { method: 'PUT', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { cell: { status: 'UPDATING' } } }));

const waitForCell1Updated = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId1}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { cell: { status: 'ACTIVE' } } }))
  .waitForAssertions(singleBuildPoll);

// 9. Occupancy guard: deleting a cell that still holds tenants → 409
//    (ADR-014 — the atomic emptiness check rejects it).
const deleteCellOccupied = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId1}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 409 }));

// 10. Offboard tenant #1 — 202; the record disappears when the tenant delete
//     script has run and the terminal transaction freed the slot.
const deleteTenant1 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { tenant: { status: 'DELETING' } } }));

const waitForTenant1Gone = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId1}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);

// The slot was freed transactionally with the record removal (§6).
const getCell1SlotFreed = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId1}`, { method: 'GET', headers: authHeaders })
  .expect(
    ExpectedResult.objectLike({
      status: 200,
      body: { cell: { status: 'ACTIVE', tenantCount: 1, maxTenants: 2 } },
    }),
  );

// The tenant delete script removed the per-tenant deployment. GetParameters
// (plural) reports a missing name in InvalidParameters instead of throwing.
const checkTenantParam1Gone = integ.assertions
  .awsApiCall('SSM', 'getParameters', {
    Names: [`/application-plane/tenants/${tenantId1}`],
  })
  .expect(
    ExpectedResult.objectLike({
      Parameters: [],
      InvalidParameters: [`/application-plane/tenants/${tenantId1}`],
    }),
  );
checkTenantParam1Gone.provider.addToRolePolicy(ssmReadPolicy);

// 11. Offboard tenants #2 and #3.
const deleteTenant2 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { tenant: { status: 'DELETING' } } }));
const waitForTenant2Gone = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId2}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);

const deleteTenant3 = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId3}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { tenant: { status: 'DELETING' } } }));
const waitForTenant3Gone = integ.assertions
  .httpApiCall(`${apiUrl}tenants/${tenantId3}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);

// No per-tenant deployments remain.
const checkTenantNamespaceEmpty = integ.assertions
  .awsApiCall('SSM', 'getParametersByPath', {
    Path: '/application-plane/tenants',
    Recursive: true,
  })
  .expect(ExpectedResult.objectLike({ Parameters: [] }));
checkTenantNamespaceEmpty.provider.addToRolePolicy(ssmReadPolicy);

// 12. Deprovision both (now empty) cells — 202; each record disappears when
//     the cell delete script has run.
const deleteCell1 = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId1}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { cell: { status: 'DELETING' } } }));
const waitForCell1Gone = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId1}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);

const deleteCell3 = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId3}`, { method: 'DELETE', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 202, body: { cell: { status: 'DELETING' } } }));
const waitForCell3Gone = integ.assertions
  .httpApiCall(`${apiUrl}cells/${cellId3}`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 404 }))
  .waitForAssertions(singleBuildPoll);

// The fleet is empty and the cell delete scripts cleaned their namespaces.
const listCellsEmpty = integ.assertions
  .httpApiCall(`${apiUrl}cells`, { method: 'GET', headers: authHeaders })
  .expect(ExpectedResult.objectLike({ status: 200, body: { cells: [] } }));

const checkCellNamespacesEmpty = integ.assertions
  .awsApiCall('SSM', 'getParametersByPath', {
    Path: '/application-plane/cells',
    Recursive: true,
  })
  .expect(ExpectedResult.objectLike({ Parameters: [] }));
checkCellNamespacesEmpty.provider.addToRolePolicy(ssmReadPolicy);

// Sequence the lifecycle strictly (references alone order most of it, but
// the reads/guards must not race the polls, and the in-flight 409 must fire
// while tenant #3 is still CREATING).
createUser
  .next(randomPassword)
  .next(setPassword)
  .next(authenticate)
  // onboard #1 → first cell
  .next(createTenant1)
  .next(waitForActive1)
  .next(listCellsOne)
  .next(getCell1)
  .next(checkCellParam)
  .next(checkTenantParam1)
  // onboard #2 → cell reuse (+ clientToken replay + mismatch 409, ADR-017)
  .next(createTenant2)
  .next(waitForActive2)
  .next(replayCreateTenant2)
  .next(reuseTokenMismatch)
  .next(listCellsStillOne)
  // onboard #3 → new cell (+ in-flight guard)
  .next(createTenant3)
  .next(deleteWhileCreating)
  .next(waitForActive3)
  .next(listCellsTwo)
  // reads
  .next(getResource1)
  .next(listTenantsByCell1)
  .next(listTenantsUnknownCell)
  // updates
  .next(updateTenant1)
  .next(getTenant1Updated)
  .next(updateResource1)
  .next(waitForTenant1Updated)
  .next(updateCell1)
  .next(waitForCell1Updated)
  // guards
  .next(deleteCellOccupied)
  // offboard tenants
  .next(deleteTenant1)
  .next(waitForTenant1Gone)
  .next(getCell1SlotFreed)
  .next(checkTenantParam1Gone)
  .next(deleteTenant2)
  .next(waitForTenant2Gone)
  .next(deleteTenant3)
  .next(waitForTenant3Gone)
  .next(checkTenantNamespaceEmpty)
  // deprovision cells
  .next(deleteCell1)
  .next(waitForCell1Gone)
  .next(deleteCell3)
  .next(waitForCell3Gone)
  .next(listCellsEmpty)
  .next(checkCellNamespacesEmpty);
