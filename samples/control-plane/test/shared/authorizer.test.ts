// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {
  buildPolicy,
  DEFAULT_ALLOWED_ROLES,
  extractBearerToken,
  parseAllowedRoles,
} from '../../src/shared/authorizer-policy';

describe('parseAllowedRoles', () => {
  test('defaults to the operator role when unset', () => {
    expect([...parseAllowedRoles(undefined)]).toEqual([...DEFAULT_ALLOWED_ROLES]);
    expect(parseAllowedRoles(undefined).has('operator')).toBe(true);
  });

  test('defaults to the operator role when empty or whitespace', () => {
    expect(parseAllowedRoles('').has('operator')).toBe(true);
    expect(parseAllowedRoles('   ').has('operator')).toBe(true);
  });

  test('parses a comma-separated list, trimming entries and dropping empties', () => {
    const roles = parseAllowedRoles(' operator, admin ,,platform-admin ');
    expect(roles.has('operator')).toBe(true);
    expect(roles.has('admin')).toBe(true);
    expect(roles.has('platform-admin')).toBe(true);
    expect(roles.size).toBe(3);
  });

  test('a custom list does not implicitly include the default', () => {
    const roles = parseAllowedRoles('admin');
    expect(roles.has('operator')).toBe(false);
    expect(roles.has('admin')).toBe(true);
  });

  test('throws when set but containing no role names (fail closed, loudly)', () => {
    expect(() => parseAllowedRoles(',,')).toThrow(/no role names/);
    expect(() => parseAllowedRoles(' , , ')).toThrow(/no role names/);
  });
});

describe('extractBearerToken', () => {
  test('extracts the token from a Bearer header', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  test('is case-insensitive on the scheme and tolerates whitespace', () => {
    expect(extractBearerToken('  bearer abc ')).toBe('abc');
  });

  test('returns undefined for missing or malformed values', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken('abc.def.ghi')).toBeUndefined();
    expect(extractBearerToken('Basic abc')).toBeUndefined();
    expect(extractBearerToken('Bearer')).toBeUndefined();
  });
});

describe('buildPolicy', () => {
  const methodArn = 'arn:aws:execute-api:eu-central-1:123456789012:api123/prod/POST/tenants';

  test('widens the resource to the whole stage for result caching', () => {
    const policy = buildPolicy(methodArn, 'Allow', 'operator-1');
    expect(policy.policyDocument.Statement[0]).toEqual({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: 'arn:aws:execute-api:eu-central-1:123456789012:api123/prod/*',
    });
    expect(policy.principalId).toBe('operator-1');
  });

  test('carries the caller context on Allow', () => {
    const policy = buildPolicy(methodArn, 'Allow', 'operator-1', {
      operatorId: 'operator-1',
      role: 'operator',
    });
    expect(policy.context).toEqual({ operatorId: 'operator-1', role: 'operator' });
  });

  test('builds a Deny policy without context', () => {
    const policy = buildPolicy(methodArn, 'Deny', 'unknown');
    expect(policy.policyDocument.Statement[0].Effect).toBe('Deny');
    expect(policy.context).toBeUndefined();
  });
});
