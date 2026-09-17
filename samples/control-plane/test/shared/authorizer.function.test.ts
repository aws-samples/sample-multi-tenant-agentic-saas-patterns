// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import type { APIGatewayTokenAuthorizerEvent } from 'aws-lambda';

/**
 * Handler tests for the hardened authorizer.
 *
 * `jose` v6 is ESM-only and cannot be loaded by the CJS jest runner without
 * `--experimental-vm-modules`, so it is replaced with a stub that faithfully
 * implements the documented `jwtVerify` contract for exactly the options
 * under test (`algorithms`, `requiredClaims`, `issuer`, `audience`). The
 * tests therefore verify two things: that the handler wires the hardening
 * options into `jwtVerify`, and that it maps verification outcomes to the
 * right policy and caller context.
 */

interface VerifyOptions {
  issuer?: string;
  audience?: string;
  algorithms?: string[];
  requiredClaims?: string[];
}

const mockJwtVerify = jest.fn(
  async (token: string, _jwks: unknown, options: VerifyOptions) => {
    const [rawHeader, rawPayload] = token.split('.');
    const header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(rawPayload, 'base64url').toString());
    // Contract-faithful checks mirroring jose's documented behaviour:
    if (options.algorithms !== undefined && !options.algorithms.includes(header.alg)) {
      throw new Error('"alg" (Algorithm) Header Parameter value not allowed');
    }
    for (const claim of options.requiredClaims ?? []) {
      if (!(claim in payload)) {
        throw new Error(`missing required "${claim}" claim`);
      }
    }
    if (options.issuer !== undefined && payload.iss !== options.issuer) {
      throw new Error('unexpected "iss" claim value');
    }
    if (options.audience !== undefined && payload.aud !== options.audience) {
      throw new Error('unexpected "aud" claim value');
    }
    return { payload, protectedHeader: header };
  },
);
const mockCreateRemoteJWKSet = jest.fn((_url: URL, _options?: object) => 'remote-jwks');

jest.mock('jose', () => ({
  jwtVerify: (token: string, jwks: unknown, options: VerifyOptions) =>
    mockJwtVerify(token, jwks, options),
  createRemoteJWKSet: (url: URL, options?: object) => mockCreateRemoteJWKSet(url, options),
}));

import { handler } from '../../src/shared/authorizer.function';

const ISSUER = 'https://idp.example.com';
const AUDIENCE = 'control-plane';
const METHOD_ARN = 'arn:aws:execute-api:eu-central-1:123456789012:api123/prod/POST/tenants';

/** Builds an unsigned test token (the stub never checks the signature). */
function makeToken(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: 'rs' },
): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${enc(header)}.${enc(payload)}.sig`;
}

function event(token: string): APIGatewayTokenAuthorizerEvent {
  return { type: 'TOKEN', methodArn: METHOD_ARN, authorizationToken: `Bearer ${token}` };
}

/** Fresh copy of a fully valid claim set; tests remove entries as needed. */
function validClaims(): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'op-1',
    exp: Math.floor(Date.now() / 1000) + 300,
  };
}

const mockFetch = jest.fn(async (_input: string | URL, _init?: RequestInit) =>
  new Response(JSON.stringify({ jwks_uri: `${ISSUER}/jwks` }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }),
);

beforeAll(() => {
  process.env.VENDOR_IDP_ISSUER_URL = ISSUER;
  process.env.VENDOR_IDP_AUDIENCE = AUDIENCE;
  // Exercise the default allowed set ('operator'); the module caches config
  // on first invocation, so this must hold before any handler call.
  delete process.env.ALLOWED_ROLES;
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

describe('authorizer handler hardening', () => {
  // First test also observes the one-time (module-cached) OIDC discovery.
  test('allows a valid token with an allowed role, pins RS256 + required claims, and bounds discovery', async () => {
    const result = await handler(event(makeToken({ ...validClaims(), role: 'operator' })));

    expect(result.policyDocument.Statement[0].Effect).toBe('Allow');
    expect(result.principalId).toBe('op-1');
    expect(result.context).toEqual({ operatorId: 'op-1', role: 'operator' });

    // Item 2: hardening options actually reach jwtVerify.
    const options = mockJwtVerify.mock.calls[0][2];
    expect(options.algorithms).toEqual(['RS256']);
    expect(options.requiredClaims).toEqual(expect.arrayContaining(['exp', 'sub']));

    // Item 4: discovery fetch is bounded by an abort signal, and the JWKS
    // fetch carries an explicit timeout.
    const fetchInit = mockFetch.mock.calls[0][1] as RequestInit | undefined;
    expect(fetchInit?.signal).toBeInstanceOf(AbortSignal);
    expect(mockCreateRemoteJWKSet).toHaveBeenCalledWith(
      new URL(`${ISSUER}/jwks`),
      expect.objectContaining({ timeoutDuration: 5000 }),
    );
  });

  test('rejects a token without exp (requiredClaims)', async () => {
    const claims: Record<string, unknown> = { ...validClaims(), role: 'operator' };
    delete claims.exp;
    const result = await handler(event(makeToken(claims)));
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    expect(result.context).toBeUndefined();
  });

  test('rejects a token without sub (requiredClaims)', async () => {
    const claims: Record<string, unknown> = { ...validClaims(), role: 'operator' };
    delete claims.sub;
    const result = await handler(event(makeToken(claims)));
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
  });

  test('rejects an unexpected algorithm (algorithms pin)', async () => {
    const result = await handler(
      event(makeToken({ ...validClaims(), role: 'operator' }, { alg: 'ES256', kid: 'ec' })),
    );
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
  });

  // M13 (threats T2/T20): a valid token from the issuer is not enough — the
  // role claim must be present and in the allowed set (default: 'operator').
  test('denies a token with a missing role claim (fail closed, M13)', async () => {
    const result = await handler(event(makeToken(validClaims())));
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    expect(result.context).toBeUndefined();
  });

  test('denies a token with an empty-string role claim (M13)', async () => {
    const result = await handler(event(makeToken({ ...validClaims(), role: '' })));
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    expect(result.context).toBeUndefined();
  });

  test('denies a token whose role is outside the allowed set (M13)', async () => {
    const result = await handler(event(makeToken({ ...validClaims(), role: 'auditor' })));
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    expect(result.context).toBeUndefined();
    // The caller authenticated successfully — keep its identity as the
    // principal for access-log attribution, even though it is denied.
    expect(result.principalId).toBe('op-1');
  });

  test('denies a non-string role claim (M13)', async () => {
    const result = await handler(event(makeToken({ ...validClaims(), role: ['operator'] })));
    expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
  });
});
