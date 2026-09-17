// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type {
  APIGatewayAuthorizerResult,
  APIGatewayTokenAuthorizerEvent,
} from 'aws-lambda';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { buildPolicy, extractBearerToken, parseAllowedRoles } from './authorizer-policy';
import { requireEnv } from './service-config';

/**
 * Vendor IdP Lambda Authorizer (TOKEN type) — the ingress layer.
 *
 * Validates the caller's vendor IdP JWT against the IdP's JWKS (discovered
 * via OIDC metadata), enforces the `role` claim against the allowed set
 * (`ALLOWED_ROLES`, default `operator` — M13), and writes the caller
 * context (`operatorId`, `role`) into the authorizer context for the
 * handler to pass through. The logic layer never sees or decodes a JWT.
 *
 * Failure modes:
 * - Missing/malformed Authorization header → throws 'Unauthorized' (401)
 * - Failed signature/issuer/audience verification → Deny policy (403)
 * - Missing role claim, or role not in the allowed set → Deny policy (403)
 */

interface AuthorizerConfig {
  issuerUrl: string;
  audience: string;
  allowedRoles: ReadonlySet<string>;
  jwks: ReturnType<typeof createRemoteJWKSet>;
}

let cachedConfig: AuthorizerConfig | undefined;

/** Discovers the JWKS URI from OIDC metadata; cached for the Lambda lifetime. */
async function getConfig(): Promise<AuthorizerConfig> {
  if (cachedConfig !== undefined) {
    return cachedConfig;
  }
  const issuerUrl = requireEnv('VENDOR_IDP_ISSUER_URL').replace(/\/$/, '');
  const audience = requireEnv('VENDOR_IDP_AUDIENCE');

  const discoveryUrl = `${issuerUrl}/.well-known/openid-configuration`;
  // Fail fast on a hanging IdP metadata endpoint instead of pinning the
  // Lambda until its own timeout.
  const response = await fetch(discoveryUrl, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    throw new Error(`OIDC discovery failed: ${discoveryUrl} → ${response.status}`);
  }
  const metadata = (await response.json()) as { jwks_uri?: string };
  if (metadata.jwks_uri === undefined) {
    throw new Error(`OIDC discovery document has no jwks_uri: ${discoveryUrl}`);
  }

  cachedConfig = {
    issuerUrl,
    audience,
    // M13: the role allowlist is deployment configuration, resolved once at
    // cold start alongside the issuer/audience. Unset defaults to 'operator'.
    allowedRoles: parseAllowedRoles(process.env.ALLOWED_ROLES),
    // timeoutDuration bounds the JWKS fetch the same way (explicit, matching
    // the discovery timeout above, rather than relying on the library default).
    jwks: createRemoteJWKSet(new URL(metadata.jwks_uri), { timeoutDuration: 5000 }),
  };
  return cachedConfig;
}

/** TOKEN authorizer entry point. */
export async function handler(
  event: APIGatewayTokenAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> {
  const token = extractBearerToken(event.authorizationToken);
  if (token === undefined) {
    // Missing or malformed header → 401
    throw new Error('Unauthorized');
  }

  const config = await getConfig();
  try {
    const { payload } = await jwtVerify(token, config.jwks, {
      issuer: config.issuerUrl,
      audience: config.audience,
      // A JWKS-backed OIDC issuer signs with RSA (RS256); pinning stops
      // verification from accepting whatever other key types or algorithms
      // happen to appear in the JWKS.
      algorithms: ['RS256'],
      // Without requiredClaims a token minted without `exp` never expires;
      // `sub` is the operator identity the whole context hangs off.
      requiredClaims: ['exp', 'sub'],
    });
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      return buildPolicy(event.methodArn, 'Deny', 'unknown');
    }
    // M13 (threats T2/T20): enforce the role claim. Authentication alone is
    // not authorization — a valid token from the configured issuer is only
    // authorized when it carries a role in the allowed set. A missing role
    // claim is denied, never defaulted to a named role (fail closed): a
    // fabricated 'operator' would grant by omission, and issuer scope creep
    // or a misconfigured issuer would silently mint control-plane admins.
    if (typeof payload.role !== 'string' || !config.allowedRoles.has(payload.role)) {
      return buildPolicy(event.methodArn, 'Deny', payload.sub);
    }
    return buildPolicy(event.methodArn, 'Allow', payload.sub, {
      operatorId: payload.sub,
      role: payload.role,
    });
  } catch {
    // Signature/issuer/audience verification failed → 403
    return buildPolicy(event.methodArn, 'Deny', 'unknown');
  }
}
