#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Sample tenant CREATE script.
#
# Runs in AWS CodeBuild with: TENANT_ID, CELL_ID, OPERATION, ADMIN_EMAIL
# (create only). Demonstrates the application-plane patterns from the design:
#   - the cell's shared resource identifiers are read from
#     /application-plane/cells/<cellId>/* at deploy time - the cell -> tenant
#     contract (architecture.md section 7, extending ADR-010)
#   - user bootstrap is the create script's responsibility (ADR-004)
#
# The per-tenant deployment it provisions is deliberately tiny: one SSM
# parameter per tenant standing in for real infrastructure (a real script
# would run CDK/Terraform/CloudFormation here).
set -euo pipefail

: "${TENANT_ID:?TENANT_ID env var is required}"
: "${CELL_ID:?CELL_ID env var is required}"
: "${ADMIN_EMAIL:?ADMIN_EMAIL env var is required}"

echo "Provisioning tenant ${TENANT_ID} into cell ${CELL_ID}"

# Cell-published shared resource, read at deploy time. The cell create script
# published this before any tenant build ran. Fail fast when missing -
# surfaces as CREATE_FAILED with the parameter named in the build log.
CELL_SHARED_ENDPOINT=$(aws ssm get-parameter \
  --name "/application-plane/cells/${CELL_ID}/shared-endpoint" \
  --query Parameter.Value --output text)
# Build logs are readable by anyone with log-group access - log the
# parameter NAME, never its VALUE (in a real deployment this could be a
# secret; see scripts/CONVENTIONS.md).
echo "Read /application-plane/cells/${CELL_ID}/shared-endpoint"

# Application-plane user bootstrap - the control plane passed ADMIN_EMAIL
# through exactly once; everything from here (user creation, invite, temp
# credentials) is this script's responsibility. The demo just records it.
# ADMIN_EMAIL is PII - never echo it (build logs are readable by anyone
# with log-group access; see scripts/CONVENTIONS.md).
echo "Bootstrapping first admin user"

aws ssm put-parameter \
  --name "/application-plane/tenants/${TENANT_ID}" \
  --type String \
  --overwrite \
  --value "{\"endpoint\":\"${TENANT_ID}.${CELL_SHARED_ENDPOINT}\",\"cellId\":\"${CELL_ID}\",\"adminUser\":\"${ADMIN_EMAIL}\",\"provisionedBy\":\"create.sh\"}"
echo "Wrote /application-plane/tenants/${TENANT_ID}"

echo "Tenant ${TENANT_ID} provisioned in cell ${CELL_ID}"
