#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
# Sample NO-OP UPDATE script. See create.sh for when to use this trio.
set -euo pipefail

echo "No-op ${OPERATION:-update}: nothing to re-apply"
