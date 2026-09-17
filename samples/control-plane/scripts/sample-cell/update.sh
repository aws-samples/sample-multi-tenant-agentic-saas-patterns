#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Sample cell UPDATE script.
#
# Runs in AWS CodeBuild with: CELL_ID, OPERATION. Re-applies the shared cell
# deployment - a real script would re-run its IaC deployment here.
# Idempotent by design.
set -euo pipefail

: "${CELL_ID:?CELL_ID env var is required}"

echo "Re-applying shared deployment for cell ${CELL_ID}"

# Global shared resources are re-resolved on every deploy - a changed shared
# value takes effect on the next update build with no control plane change
# (ADR-010).
SHARED_BASE_DOMAIN=$(aws ssm get-parameter \
  --name /application-plane/shared/base-domain \
  --query Parameter.Value --output text)

aws ssm put-parameter \
  --name "/application-plane/cells/${CELL_ID}/shared-endpoint" \
  --type String \
  --overwrite \
  --value "cell-${CELL_ID}.${SHARED_BASE_DOMAIN}"
# Log the parameter NAME, never its VALUE - build logs are readable by
# anyone with log-group access (see scripts/CONVENTIONS.md).
echo "Wrote /application-plane/cells/${CELL_ID}/shared-endpoint"

aws ssm put-parameter \
  --name "/application-plane/cells/${CELL_ID}/provisioned" \
  --type String \
  --overwrite \
  --value "{\"cellId\":\"${CELL_ID}\",\"provisionedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"provisionedBy\":\"update.sh\"}"
echo "Wrote /application-plane/cells/${CELL_ID}/provisioned"

echo "Shared deployment for cell ${CELL_ID} re-applied"
