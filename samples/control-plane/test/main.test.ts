// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { isFullCommitSha, sourcePinningWarning } from '../src/shared/service-config';
import { CellDefinition, TenantStack } from '../src/tenant/tenant.cdk';

const cellDefinition: CellDefinition = {
  source: { type: 'GITHUB', location: 'https://github.com/acme/provisioning.git' },
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
  maxTenants: 10,
};

// Skip NodejsFunction esbuild bundling in unit tests - assertions target
// infrastructure shape, not bundle contents.
function synth(): Template {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new TenantStack(app, 'test', {
    vendorIdpIssuerUrl: 'https://idp.example.com',
    vendorIdpAudience: 'control-plane',
    cellDefinition,
  });
  return Template.fromStack(stack);
}

describe('TenantStack', () => {
  const template = synth();

  test('control plane table has PITR enabled and both GSIs', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      Replicas: Match.arrayWith([
        Match.objectLike({
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        }),
      ]),
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'GSI1' }),
        Match.objectLike({ IndexName: 'GSI2' }),
      ]),
    });
  });

  test('provisioning state machine and the two shared CodeBuild projects exist', () => {
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    // One project for cell builds, one for tenant builds (ADR-002, ADR-012).
    template.resourceCountIs('AWS::CodeBuild::Project', 2);
  });

  test('state machine may start and poll builds on the shared projects only', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['codebuild:StartBuild', 'codebuild:StopBuild', 'codebuild:BatchGetBuilds'],
          }),
        ]),
      },
    });
  });

  test('API is created from the OpenAPI spec with patched integrations', () => {
    const apis = template.findResources('AWS::ApiGateway::RestApi');
    const api = Object.values(apis)[0] as any;
    const body = api.Properties.Body;
    // All PLACEHOLDER URIs were patched at synth time
    expect(JSON.stringify(body)).not.toContain('PLACEHOLDER');
    // Token authorizer present
    const authorizer =
      body.components.securitySchemes['vendor-authorizer']['x-amazon-apigateway-authorizer'];
    expect(authorizer.type).toBe('token');
    // All eleven operations across five paths exist
    expect(Object.keys(body.paths).sort()).toEqual([
      '/cells',
      '/cells/{cellId}',
      '/tenants',
      '/tenants/{tenantId}',
      '/tenants/{tenantId}/resource',
    ]);
  });

  test('API handler receives the cellDefinition and workflow wiring', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          CELL_DEFINITION: JSON.stringify(cellDefinition),
          GSI1_NAME: 'GSI1',
          GSI2_NAME: 'GSI2',
        }),
      },
    });
  });

  test('authorizer receives the vendor IdP configuration and the role allowlist (M13)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          VENDOR_IDP_ISSUER_URL: 'https://idp.example.com',
          VENDOR_IDP_AUDIENCE: 'control-plane',
          ALLOWED_ROLES: 'operator',
        },
      },
    });
  });

  test('synth fails on an invalid cellDefinition (§10)', () => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    expect(
      () =>
        new TenantStack(app, 'invalid', {
          vendorIdpIssuerUrl: 'https://idp.example.com',
          vendorIdpAudience: 'control-plane',
          cellDefinition: { ...cellDefinition, maxTenants: 0 },
        }),
    ).toThrow(/maxTenants/);
  });

  test('API url is published to SSM for discovery', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/control-plane/tenant-api-url',
    });
  });

  test('access logging attributes every request to the authorizer principal (T9 / M12)', () => {
    const stages = template.findResources('AWS::ApiGateway::Stage');
    const stage = Object.values(stages)[0] as any;
    const accessLog = stage.Properties.AccessLogSetting;
    expect(accessLog.DestinationArn).toBeDefined();
    const format = JSON.parse(accessLog.Format);
    // The operator identity — the verified JWT sub — is the audit chain's
    // first link, present on Allow AND Deny.
    expect(format.operatorId).toBe('$context.authorizer.principalId');
    // The minimum attribution fields.
    expect(format.requestId).toBe('$context.requestId');
    expect(format.ip).toBe('$context.identity.sourceIp');
    expect(format.requestTime).toBe('$context.requestTime');
    expect(format.httpMethod).toBe('$context.httpMethod');
    expect(format.resourcePath).toBe('$context.resourcePath');
    expect(format.status).toBe('$context.status');
  });

  test('both CodeBuild projects cap concurrent builds (T16 / M17)', () => {
    const projects = Object.values(template.findResources('AWS::CodeBuild::Project'));
    expect(projects).toHaveLength(2);
    for (const project of projects as any[]) {
      expect(project.Properties.ConcurrentBuildLimit).toBe(5);
    }
  });

  test('surge and client-error alarms exist without actions (T16 / M17)', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    // State machine execution surge — the CreateTenant amplification signature.
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/States',
      MetricName: 'ExecutionsStarted',
      Statistic: 'Sum',
      Period: 300,
      Threshold: 20,
      ComparisonOperator: 'GreaterThanThreshold',
    });
    // API 4XX — probing / leaked-token signature at the edge.
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/ApiGateway',
      MetricName: '4XXError',
      Period: 300,
      Threshold: 50,
    });
  });

  test('every log group has bounded retention (T13 / M15)', () => {
    const logGroups = Object.values(template.findResources('AWS::Logs::LogGroup'));
    // API access logs, state machine logs, two CodeBuild project logs, two
    // Lambda function logs — none may default to never-expire.
    expect(logGroups.length).toBeGreaterThanOrEqual(6);
    for (const logGroup of logGroups as any[]) {
      expect(logGroup.Properties.RetentionInDays).toBe(30);
    }
  });

  test('the workflow forwards the operator identity and the source pin to CodeBuild (M12 / M10)', () => {
    const machines = template.findResources('AWS::StepFunctions::StateMachine');
    const definition = JSON.stringify(
      (Object.values(machines)[0] as any).Properties.DefinitionString,
    );
    // M12 (T10): OPERATOR_ID rides every build's environment overrides.
    expect(definition).toContain('OPERATOR_ID');
    expect(definition).toContain('$.operatorId');
    // M10 (T5): a non-empty stamped pin becomes the SourceVersion override;
    // the pinned/unpinned split means the empty string is never sent.
    expect(definition).toContain('SourceVersion');
    expect(definition).toContain('$.sourceVersion');
  });

  test('an extra source.sourceVersion is carried through to the CELL_DEFINITION env var', () => {
    // The pinned ref is part of the stamped definition: it must survive the
    // context -> stack -> Lambda env pass-through untouched (T5 / M10).
    const pinned = {
      ...cellDefinition,
      source: { ...cellDefinition.source, sourceVersion: 'a'.repeat(40) },
    } as CellDefinition;
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const stack = new TenantStack(app, 'pinned', {
      vendorIdpIssuerUrl: 'https://idp.example.com',
      vendorIdpAudience: 'control-plane',
      cellDefinition: pinned,
    });
    Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          CELL_DEFINITION: JSON.stringify(pinned),
        }),
      },
    });
  });
});

// Supply-chain pinning validation (threat model T5, mitigation M10):
// warn-and-allow — a full commit SHA is silent, everything else warns.
describe('source pinning (T5 / M10)', () => {
  const fullSha = '4f0c9e1b2a3d4c5e6f708192a3b4c5d6e7f80912';

  test('isFullCommitSha accepts a full 40-char commit SHA only', () => {
    expect(isFullCommitSha(fullSha)).toBe(true);
    expect(isFullCommitSha(fullSha.toUpperCase())).toBe(true);
    expect(isFullCommitSha(fullSha.slice(0, 7))).toBe(false); // short SHA is resolvable, not pinned
    expect(isFullCommitSha('main')).toBe(false);
    expect(isFullCommitSha('v1.2.3')).toBe(false);
    expect(isFullCommitSha('')).toBe(false);
    expect(isFullCommitSha(undefined)).toBe(false);
    expect(isFullCommitSha(`${fullSha}0`)).toBe(false); // 41 chars
    expect(isFullCommitSha('z'.repeat(40))).toBe(false); // not hex
  });

  test('a full commit SHA is accepted silently', () => {
    expect(sourcePinningWarning({ location: 'https://github.com/acme/provisioning.git', sourceVersion: fullSha }))
      .toBeUndefined();
  });

  test('a branch or tag ref warns about the supply-chain risk', () => {
    for (const mutableRef of ['main', 'release/2026-09', 'v1.2.3']) {
      const warning = sourcePinningWarning({ location: 'https://...', sourceVersion: mutableRef });
      expect(warning).toContain(mutableRef);
      expect(warning).toContain('mutable ref');
      expect(warning).toMatch(/T5/);
      expect(warning).toMatch(/commit SHA/);
    }
  });

  test('an absent sourceVersion warns that builds fetch the default branch HEAD', () => {
    for (const source of [
      { location: 'https://...' },
      { location: 'https://...', sourceVersion: '' },
      { location: 'https://...', sourceVersion: '   ' },
      undefined,
    ]) {
      const warning = sourcePinningWarning(source);
      expect(warning).toContain('default branch HEAD');
      expect(warning).toMatch(/T5/);
    }
  });
});
