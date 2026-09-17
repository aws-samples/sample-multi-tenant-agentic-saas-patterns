// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { Annotations, App, Aspects, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { sourcePinningWarning } from './shared/service-config';
import { CellDefinition, TenantStack } from './tenant/tenant.cdk';

const app = new App();

// Security linting (cdk-nag v3): evaluate every construct against the AWS
// Solutions rule pack at synth time via CDK's policy validation framework.
// Findings fail synthesis; intentional deviations are acknowledged per
// construct with a documented reason. writeSuppressionsToCloudFormation
// copies each acknowledgment into the synthesized templates as
// cdk_nag.rules_to_suppress Metadata - the audit trail travels with the
// templates (and the committed integ snapshot) alongside the cfn_nag and
// checkov annotations.
Validations.of(app).addPlugins(
  new AwsSolutionsChecks(app, { verbose: true, writeSuppressionsToCloudFormation: true }),
);

// Deployment inputs (architecture.md §10), supplied via CDK context
// (cdk.json or --context). ALL THREE are required — synthesis fails fast
// with the full list rather than deploying a stack whose every request
// 500s against a placeholder issuer (S3):
// - the vendor IdP - public OIDC discovery values consumed by the Lambda
//   Authorizer. Customer identity is an application plane decision (ADR-004).
// - the CellDefinition - one source + two script sets + maxTenants, stamped
//   onto each cell record at creation (ADR-012). Validated at synth time.
const vendorIdpIssuerUrl = requireContext('vendorIdpIssuerUrl');
const vendorIdpAudience = requireContext('vendorIdpAudience');
const cellDefinition = parseCellDefinitionContext(requireContext('cellDefinition'));

const stack = new TenantStack(app, 'control-plane-dev', {
  vendorIdpIssuerUrl: String(vendorIdpIssuerUrl),
  vendorIdpAudience: String(vendorIdpAudience),
  cellDefinition,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

// Supply-chain pinning check (threat model T5, mitigation M10): the
// CellDefinition source is fetched fresh by CodeBuild on every lifecycle
// build. Warn — do not fail — when source.sourceVersion is absent or a
// mutable ref instead of a full commit SHA. Structural validation of the
// rest of the definition happens in the stack (fails synth, §10).
const pinningWarning = sourcePinningWarning(cellDefinition.source);
if (pinningWarning !== undefined) {
  Annotations.of(stack).addWarningV2('control-plane:mutable-source-ref', pinningWarning);
}

app.synth();

/** Fails synthesis with the complete required-context recipe when a deployment input is missing. */
function requireContext(key: string): unknown {
  const value = app.node.tryGetContext(key);
  if (value === undefined || value === '') {
    throw new Error(
      [
        `Missing required CDK context '${key}'. This app needs all three deployment inputs (architecture.md §10):`,
        '',
        '  npx cdk deploy \\',
        '    --context vendorIdpIssuerUrl=https://YOUR_ISSUER \\',
        '    --context vendorIdpAudience=YOUR_AUDIENCE \\',
        '    --context cellDefinition=\'{"source":{...},"cellScripts":{...},"tenantScripts":{...},"maxTenants":N}\'',
        '',
        'See the README "Deploy" section for a complete cellDefinition example.',
      ].join('\n'),
    );
  }
  return value;
}

/**
 * Accepts the cellDefinition context as an object (cdk.json) or a JSON
 * string (`--context cellDefinition='{...}'`). Structural validation
 * happens in the stack (fails synth, §10).
 */
function parseCellDefinitionContext(context: unknown): CellDefinition {
  if (typeof context === 'string') {
    try {
      return JSON.parse(context) as CellDefinition;
    } catch (error) {
      throw new Error(`The cellDefinition context value is not valid JSON: ${(error as Error).message}`);
    }
  }
  return context as CellDefinition;
}
