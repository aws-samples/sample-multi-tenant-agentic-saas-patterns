// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { CfnResource, Stack, Validations } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

/**
 * Acknowledges a GRANULAR cdk-nag finding (`RuleId[FindingId]`) on a construct.
 *
 * `Validations.of(scope).acknowledge()` rejects any ID containing more than
 * one `::`, but cdk-nag's granular finding IDs legitimately contain several
 * (`Resource::`, `<AWS::Partition>`, `iam::aws`). cdk-nag reads acknowledgments
 * from the documented `Validations.ACKNOWLEDGED_RULES_METADATA_KEY` construct
 * metadata and compares raw keys, so recording the metadata directly is the
 * supported escape hatch. Non-granular rule IDs should use
 * `Validations.of(scope).acknowledge()` as normal.
 */
export function acknowledgeGranularFinding(scope: IConstruct, id: string, reason: string): void {
  scope.node.addMetadata(Validations.ACKNOWLEDGED_RULES_METADATA_KEY, { [id]: reason });
}

/**
 * Renders a CDK token string the way cdk-nag renders IAM policy resources in
 * granular finding IDs (`AwsSolutions-IAM5[Resource::...]`): the value is
 * resolved to its CloudFormation form and intrinsics are flattened to
 * `<Name>` placeholders (mirroring cdk-nag's internal flattenCfnReference,
 * which is not exported).
 *
 * Building acknowledgment IDs from the SAME token that produced the policy
 * resource keeps them exact-match correct in any account, Region, or
 * partition - hardcoding the rendered string would pin the synth Region.
 */
export function nagFindingResource(scope: IConstruct, value: string): string {
  return flatten(Stack.of(scope).resolve(value));
}

function flatten(node: unknown): string {
  if (node === undefined) {
    return '';
  }
  if (typeof node === 'string') {
    // Fn::Sub template syntax -> angle brackets, as cdk-nag does
    return node.replace(/\$\{/g, '<').replace(/\}/g, '>');
  }
  const obj = node as Record<string, unknown>;
  if (obj['Fn::Join'] !== undefined) {
    const [delimiter, items] = obj['Fn::Join'] as [string, unknown[]];
    return items.map(flatten).join(delimiter);
  }
  if (obj['Fn::Sub'] !== undefined) {
    return flatten(obj['Fn::Sub']);
  }
  if (obj['Fn::GetAtt'] !== undefined) {
    const [resource, attribute] = obj['Fn::GetAtt'] as [unknown, unknown];
    return `<${flatten(resource)}.${flatten(attribute)}>`;
  }
  if (obj['Fn::ImportValue'] !== undefined) {
    return flatten(obj['Fn::ImportValue']);
  }
  if (obj.Ref !== undefined) {
    return `<${flatten(obj.Ref)}>`;
  }
  return JSON.stringify(node);
}

/** A cfn_nag rule suppression (`W`/`F` rule id + documented reason). */
export interface CfnNagSuppression {
  readonly id: string;
  readonly reason: string;
}

/** A checkov skip (`CKV_*` rule id + documented reason). */
export interface CheckovSkip {
  readonly id: string;
  readonly comment: string;
}

/**
 * Records cfn_nag and/or checkov suppressions as CloudFormation resource
 * Metadata (`cfn_nag.rules_to_suppress` / `checkov.skip`) — the native
 * per-resource suppression mechanism each scanner reads when it runs
 * against the synthesized templates (e.g. the committed integ snapshot).
 *
 * This is the template-scanner counterpart of the cdk-nag acknowledgments
 * above: cdk-nag governs findings at synth time, while these annotations
 * travel WITH the templates so external scans of the generated artifacts
 * see the same documented decisions.
 *
 * Accepts either a `CfnResource` directly or any construct whose
 * `defaultChild` is one. Repeated calls merge.
 */
export function suppressTemplateScanners(
  scope: IConstruct,
  suppressions: { cfnNag?: CfnNagSuppression[]; checkov?: CheckovSkip[] },
): void {
  const resource = CfnResource.isCfnResource(scope)
    ? scope
    : (scope.node.defaultChild as CfnResource | undefined);
  if (resource === undefined || !CfnResource.isCfnResource(resource)) {
    throw new Error(`suppressTemplateScanners: ${scope.node.path} has no CfnResource default child`);
  }
  if (suppressions.cfnNag !== undefined && suppressions.cfnNag.length > 0) {
    const existing = (resource.getMetadata('cfn_nag') as { rules_to_suppress?: CfnNagSuppression[] } | undefined)
      ?.rules_to_suppress ?? [];
    resource.addMetadata('cfn_nag', {
      rules_to_suppress: [...existing, ...suppressions.cfnNag],
    });
  }
  if (suppressions.checkov !== undefined && suppressions.checkov.length > 0) {
    const existing = (resource.getMetadata('checkov') as { skip?: CheckovSkip[] } | undefined)?.skip ?? [];
    resource.addMetadata('checkov', {
      skip: [...existing, ...suppressions.checkov],
    });
  }
}
