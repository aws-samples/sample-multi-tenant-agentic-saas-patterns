// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Composite key construction for the single-table DynamoDB design.
 * Keys follow the `PREFIX#id` convention, e.g. `TENANT#01J...`.
 */
export class KeyBuilder {
  /** Builds a composite key: `build('TENANT', id)` → `TENANT#<id>`. */
  static build(prefix: string, id: string): string {
    return `${prefix}#${id}`;
  }

  /**
   * Extracts the id from a composite key built with {@link KeyBuilder.build}.
   * Throws when the key does not carry the expected prefix — indicates a
   * key-building bug, not bad input.
   */
  static parse(prefix: string, key: string): string {
    const expected = `${prefix}#`;
    if (!key.startsWith(expected)) {
      throw new Error(`Key '${key}' does not have expected prefix '${expected}'`);
    }
    return key.slice(expected.length);
  }
}
