#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Sample cell CREATE script.
#
# Runs in AWS CodeBuild with: CELL_ID, OPERATION.
# Provisions the cell's SHARED application deployment and publishes its
# resource identifiers to the cell namespace so tenant scripts can read them
# at deploy time - the cell -> tenant contract (architecture.md section 7):
#   - global shared resources are read from /application-plane/shared/* (ADR-010)
#   - the cell publishes to /application-plane/cells/<cellId>/<name>
#
# The "shared deployment" it provisions is deliberately tiny: one SSM
# parameter per cell standing in for real shared infrastructure (a real
# script would run CDK/Terraform/CloudFormation here).
set -euo pipefail

: "${CELL_ID:?CELL_ID env var is required}"

echo "Provisioning shared deployment for cell ${CELL_ID}"

# Global shared resource, read at deploy time. Fail fast when missing -
# surfaces as CREATE_FAILED with the parameter named in the build log.
SHARED_BASE_DOMAIN=$(aws ssm get-parameter \
  --name /application-plane/shared/base-domain \
  --query Parameter.Value --output text)
# Build logs are readable by anyone with log-group access - log the
# parameter NAME, never its VALUE (in a real deployment this could be a
# secret; see scripts/CONVENTIONS.md).
echo "Read /application-plane/shared/base-domain"

# Publish the cell's shared resource identifiers. Tenant create/update
# scripts read this namespace - it is the only channel between the shared
# cell deployment and its tenants. --overwrite keeps reruns safe after
# partial completion.
aws ssm put-parameter \
  --name "/application-plane/cells/${CELL_ID}/shared-endpoint" \
  --type String \
  --overwrite \
  --value "cell-${CELL_ID}.${SHARED_BASE_DOMAIN}"
echo "Wrote /application-plane/cells/${CELL_ID}/shared-endpoint"

aws ssm put-parameter \
  --name "/application-plane/cells/${CELL_ID}/provisioned" \
  --type String \
  --overwrite \
  --value "{\"cellId\":\"${CELL_ID}\",\"provisionedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"provisionedBy\":\"create.sh\"}"
echo "Wrote /application-plane/cells/${CELL_ID}/provisioned"

echo "Shared deployment for cell ${CELL_ID} provisioned"
