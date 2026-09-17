#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Sample cell DELETE script.
#
# Runs in AWS CodeBuild with: CELL_ID, OPERATION. Deprovisions the shared
# cell deployment and cleans up EVERYTHING the cell published under
# /application-plane/cells/<cellId>/. Must tolerate partial provisioning -
# it is also the remediation path for CREATE_FAILED cells, so an empty
# namespace is success, not an error.
set -euo pipefail

: "${CELL_ID:?CELL_ID env var is required}"

echo "Deprovisioning shared deployment for cell ${CELL_ID}"

# Enumerate the whole cell namespace rather than naming parameters - the
# delete script owns the namespace and must clean up whatever any earlier
# (possibly partial) create/update run left behind.
PARAMETER_NAMES=$(aws ssm get-parameters-by-path \
  --path "/application-plane/cells/${CELL_ID}" \
  --recursive \
  --query "Parameters[].Name" --output text)

if [ -z "${PARAMETER_NAMES}" ] || [ "${PARAMETER_NAMES}" = "None" ]; then
  echo "No shared deployment found for cell ${CELL_ID} (partial provisioning) - nothing to clean up"
else
  for NAME in ${PARAMETER_NAMES}; do
    aws ssm delete-parameter --name "${NAME}"
    echo "Deleted ${NAME}"
  done
  echo "Shared deployment for cell ${CELL_ID} deprovisioned"
fi
