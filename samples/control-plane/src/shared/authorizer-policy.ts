// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { APIGatewayAuthorizerResult } from 'aws-lambda';

/**
 * Pure helpers for the vendor IdP Lambda Authorizer. Kept free of runtime
 * dependencies (notably the ESM-only `jose`) so they are unit-testable in
 * isolation.
 */

/**
 * Default allowed role set when `ALLOWED_ROLES` is not configured. The
 * dedicated control-plane issuer mints operator tokens with `role:
 * "operator"`, so the default enforces exactly that population.
 */
export const DEFAULT_ALLOWED_ROLES: readonly string[] = ['operator'];

/**
 * Parses the `ALLOWED_ROLES` environment value (comma-separated role names)
 * into the set the authorizer enforces (M13: role-claim enforcement).
 *
 * - Unset or empty → `DEFAULT_ALLOWED_ROLES` (`operator`).
 * - Set → trimmed, empty entries dropped.
 * - Set but yielding no roles (e.g. `",,"`) → throws. A deployer explicitly
 *   configured the variable and produced nothing; silently falling back to
 *   the default would widen access on a config bug, and an empty set would
 *   deny everyone without explanation. Failing fast at cold start is the
 *   fail-closed, debuggable behaviour.
 */
export function parseAllowedRoles(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === '') {
    return new Set(DEFAULT_ALLOWED_ROLES);
  }
  const roles = raw
    .split(',')
    .map((role) => role.trim())
    .filter((role) => role !== '');
  if (roles.length === 0) {
    throw new Error('ALLOWED_ROLES is set but contains no role names');
  }
  return new Set(roles);
}

/** Extracts the raw JWT from an `Authorization: Bearer <token>` value. */
export function extractBearerToken(authorizationToken: string | undefined): string | undefined {
  if (authorizationToken === undefined) {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authorizationToken.trim());
  return match?.[1];
}

/**
 * Builds the IAM policy for the authorizer result. The resource is widened
 * to every method on the API stage so the cached result (authorizer result
 * caching keyed on the token) is valid for all operations, not just the one
 * that triggered the cache fill.
 */
export function buildPolicy(
  methodArn: string,
  effect: 'Allow' | 'Deny',
  principalId: string,
  context?: Record<string, string>,
): APIGatewayAuthorizerResult {
  // arn:aws:execute-api:region:account:apiId/stage/METHOD/path → widen to stage/*
  const [apiGatewayArn, stage] = methodArn.split('/', 2);
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: effect,
          Resource: `${apiGatewayArn}/${stage}/*`,
        },
      ],
    },
    context,
  };
}
