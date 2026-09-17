// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SFNClient } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { convertEvent, convertVersion1Response } from '@smithy/server-apigateway';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { CellDataModel, CellItem, CellRecord } from './cell.data-model';
import { IdempotencyDataModel, IdempotencyItem, IdempotencyRecord } from './idempotency.data-model';
import { parseCellDefinition, TenantService, TenantServiceConfig } from './tenant';
import { TenantDataModel, TenantItem, TenantRecord } from './tenant.data-model';
import { DynamoDBRepository, PlacementTransactions } from '../shared/repository';
import { CallerContext, requireEnv } from '../shared/service-config';
import { getTenantServiceServiceHandler } from '../smithy/source/typescript-ssdk-codegen/src';

/**
 * API handler — a dumb pass-through (context separation):
 * 1. reads the authorizer output and builds the immutable `CallerContext`
 * 2. converts the API Gateway event to an HttpRequest
 * 3. dispatches to the Smithy-generated service handler
 *
 * No JWT decoding, no env-var conditionals, no business logic. Everything
 * below is initialised once at cold start.
 */

const tableName = requireEnv('TABLE_NAME');
const tenantDataModel = new TenantDataModel();
const cellDataModel = new CellDataModel();
// One document client shared by both repositories and the placement
// transactions — same marshalling behaviour everywhere.
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const config: TenantServiceConfig = {
  tenantRepository: new DynamoDBRepository<TenantRecord, TenantItem>(
    tableName,
    tenantDataModel,
    documentClient,
  ),
  cellRepository: new DynamoDBRepository<CellRecord, CellItem>(
    tableName,
    cellDataModel,
    documentClient,
  ),
  idempotencyRepository: new DynamoDBRepository<IdempotencyRecord, IdempotencyItem>(
    tableName,
    new IdempotencyDataModel(),
    documentClient,
  ),
  placement: new PlacementTransactions<CellRecord, CellItem, TenantRecord, TenantItem>(
    tableName,
    cellDataModel,
    tenantDataModel,
    documentClient,
  ),
  // The deployment-configured CellDefinition (§10) — parsed and validated
  // once at cold start; a failure here is deployment drift, never a client
  // error.
  cellDefinition: parseCellDefinition(requireEnv('CELL_DEFINITION')),
  stateMachineArn: requireEnv('STATE_MACHINE_ARN'),
  sfnClient: new SFNClient({}),
};

const service = new TenantService(config);
const serviceHandler = getTenantServiceServiceHandler<CallerContext>(service);

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const authorizer = event.requestContext.authorizer;
  const operatorId = authorizer?.operatorId;
  const role = authorizer?.role;
  if (typeof operatorId !== 'string') {
    // The authorizer guarantees this - absence is an ingress wiring bug.
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Missing caller context' }),
    };
  }
  // Immutability is enforced at the type level (readonly fields). The object
  // itself must stay extensible: the generated SSDK handler attaches
  // bookkeeping (e.g. metricsRecorder) to the context at dispatch time.
  // `role` is optional: the authorizer omits the key when the IdP issued no
  // role claim - it is never defaulted here either.
  const context: CallerContext =
    typeof role === 'string' ? { operatorId, role } : { operatorId };

  const httpResponse = await serviceHandler.handle(convertEvent(event), context);
  return convertVersion1Response(httpResponse);
}
