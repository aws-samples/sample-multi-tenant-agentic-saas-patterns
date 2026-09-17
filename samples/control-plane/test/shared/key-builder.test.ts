// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { KeyBuilder } from '../../src/shared/key-builder';
import { decodePageToken, encodePageToken } from '../../src/shared/repository';
import { ValidationException } from '../../src/smithy/source/typescript-ssdk-codegen/src';

describe('KeyBuilder', () => {
  test('build composes prefix and id', () => {
    expect(KeyBuilder.build('TENANT', '01ABC')).toBe('TENANT#01ABC');
  });

  test('parse extracts the id', () => {
    expect(KeyBuilder.parse('TENANT', 'TENANT#01ABC')).toBe('01ABC');
  });

  test('parse throws on wrong prefix', () => {
    expect(() => KeyBuilder.parse('TENANT', 'RESOURCE#01ABC')).toThrow(/expected prefix/);
  });
});

describe('pagination tokens', () => {
  test('round-trips a LastEvaluatedKey', () => {
    const key = { PK: 'TENANT#01ABC', SK: 'META' };
    const token = encodePageToken(key);
    expect(token).toBeDefined();
    expect(decodePageToken(token)).toEqual(key);
  });

  test('undefined round-trips to undefined', () => {
    expect(encodePageToken(undefined)).toBeUndefined();
    expect(decodePageToken(undefined)).toBeUndefined();
  });

  test('rejects a corrupt token with the modelled ValidationException (→ 400)', () => {
    expect(() => decodePageToken('not-a-token')).toThrow(ValidationException);
    expect(() => decodePageToken('not-a-token')).toThrow(/Invalid nextToken/);
  });
});
