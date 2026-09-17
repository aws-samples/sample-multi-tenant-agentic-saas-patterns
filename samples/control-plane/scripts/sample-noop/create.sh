#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Sample NO-OP CREATE script.
#
# An "empty" deployment is represented by explicit, idempotent no-op
# lifecycle scripts - both script sets are always required so every
# lifecycle path has a total contract (architecture.md section 1).
# Use this trio as cellScripts when tenants get everything (shared-nothing
# cells), or as tenantScripts when the cell's shared deployment carries
# everything (tenant-nothing models).
set -euo pipefail

echo "No-op ${OPERATION:-create}: nothing to provision"
