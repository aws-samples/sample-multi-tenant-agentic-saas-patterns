#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Sample tenant DELETE script.
#
# Runs in AWS CodeBuild with: TENANT_ID, CELL_ID, OPERATION. Deprovisions the
# per-tenant deployment. Must tolerate partial provisioning - it is also the
# cleanup path for CREATE_FAILED tenants (including tenants whose cell itself
# failed to create), so a missing resource is success, not an error.
set -euo pipefail

: "${TENANT_ID:?TENANT_ID env var is required}"

echo "Deprovisioning tenant ${TENANT_ID}"

if aws ssm get-parameter --name "/application-plane/tenants/${TENANT_ID}" > /dev/null 2>&1; then
  aws ssm delete-parameter --name "/application-plane/tenants/${TENANT_ID}"
  echo "Tenant ${TENANT_ID} deprovisioned"
else
  echo "No deployment found for tenant ${TENANT_ID} (partial provisioning) - nothing to clean up"
fi
