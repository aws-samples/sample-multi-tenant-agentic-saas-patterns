// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

$version: "2.0"

namespace controlplane

use aws.apigateway#authorizer

// ---------------------------------------------------------------------------
// Tenant resource
// ---------------------------------------------------------------------------

/// A tenant of the SaaS application. In the cell deployment model the tenant
/// is placed into a cell at onboarding and provisioned with its own
/// per-tenant application deployment inside that cell, using the cell's
/// stamped definition. The tenant carries no source and no scripts of its
/// own (ADR-012); its placement (cellId) is assigned at onboarding and never
/// changes.
resource Tenant {
    identifiers: {
        tenantId: TenantId
    }
    create: CreateTenant
    read: GetTenant
    update: UpdateTenant
    delete: DeleteTenant
    list: ListTenants
    resources: [
        TenantResource
    ]
}

/// The tenant's per-tenant application deployment - an embedded singleton
/// sub-resource. Readable and re-applicable independently of tenant
/// metadata; created and deleted only through the tenant lifecycle (a
/// deployment cannot exist without its tenant or outlive it). Its effective
/// definition (source, scripts) is resolved from the cell's stamped
/// definition.
resource TenantResource {
    identifiers: {
        tenantId: TenantId
    }
    read: GetResource
    update: UpdateResource
}

// ---------------------------------------------------------------------------
// Tenant summary shapes
// ---------------------------------------------------------------------------

/// A tenant as returned by the API. Includes placement, lifecycle status,
/// and build bookkeeping; the deployment's effective definition is available
/// via GetResource.
@references([{resource: Cell}])
structure TenantSummary {
    /// Unique tenant identifier.
    @required
    tenantId: TenantId

    /// Human-readable tenant name.
    @required
    name: TenantName

    /// Free-text tenant description.
    description: TenantDescription

    /// The cell this tenant is placed in - assigned at onboarding, never
    /// changes.
    @required
    cellId: CellId

    /// Current lifecycle status of the tenant and its deployment.
    @required
    status: LifecycleStatus

    /// Failure detail, populated when status is a *_FAILED value.
    statusReason: String

    /// ARN of the most recent successful tenant-scoped CodeBuild build.
    lastBuildId: String

    /// When the tenant was created.
    @required
    createdAt: IsoTimestamp

    /// When the tenant record was last modified.
    @required
    updatedAt: IsoTimestamp
}

/// A page of tenants.
list TenantList {
    member: TenantSummary
}

// ---------------------------------------------------------------------------
// CreateTenant - POST /tenants -> 202
// ---------------------------------------------------------------------------

/// Onboards a tenant. Atomically claims a slot in an ACTIVE cell with free
/// capacity - or creates a new cell record when none has capacity (ADR-013) -
/// persists the tenant in CREATING status with its cellId, and starts the
/// provisioning workflow (the tenant create build, preceded by the cell
/// create build if a new cell was needed). Carries no resource definition -
/// the cell's stamped definition applies (ADR-012). Asynchronous: returns
/// 202 immediately; poll GetTenant for the terminal status (ACTIVE or
/// CREATE_FAILED).
@authorizer("vendor-authorizer")
@http(method: "POST", uri: "/tenants", code: 202)
operation CreateTenant {
    input := {
        /// Human-readable tenant name.
        @required
        name: TenantName

        /// Free-text tenant description.
        description: TenantDescription

        /// Email of the tenant's first customer administrator. Passed to the
        /// tenant create script as ADMIN_EMAIL for application-plane user
        /// bootstrap; never persisted on the tenant record.
        @required
        adminEmail: EmailAddress

        /// Optional idempotency token. Retrying CreateTenant with the same
        /// token returns the previously onboarded tenant instead of
        /// onboarding a duplicate - the guard against a client retry after
        /// an API timeout. Reusing a token with different parameters is
        /// rejected with ConflictError. Without a token, every request
        /// onboards a new tenant.
        @idempotencyToken
        clientToken: IdempotencyToken
    }

    output := {
        /// The created tenant, in CREATING status, including its cellId
        /// placement.
        @required
        tenant: TenantSummary
    }

    errors: [
        ConflictError
    ]
}

// ---------------------------------------------------------------------------
// GetTenant - GET /tenants/{tenantId} -> 200
// ---------------------------------------------------------------------------

/// Returns a tenant. This is the polling endpoint for asynchronous lifecycle
/// operations: status, statusReason, lastBuildId, and cellId reflect
/// placement and provisioning progress.
@authorizer("vendor-authorizer")
@readonly
@http(method: "GET", uri: "/tenants/{tenantId}", code: 200)
operation GetTenant {
    input := {
        /// The tenant to fetch.
        @required
        @httpLabel
        tenantId: TenantId
    }

    output := {
        /// The requested tenant.
        @required
        tenant: TenantSummary
    }

    errors: [
        ResourceNotFoundError
    ]
}

// ---------------------------------------------------------------------------
// UpdateTenant - PUT /tenants/{tenantId} -> 200
// ---------------------------------------------------------------------------

/// Updates tenant metadata (name, description). Synchronous - metadata edits
/// never touch the deployment and are allowed in any lifecycle status.
/// Re-applying the tenant's deployment itself goes through UpdateResource.
@authorizer("vendor-authorizer")
@idempotent
@http(method: "PUT", uri: "/tenants/{tenantId}", code: 200)
operation UpdateTenant {
    input := {
        /// The tenant to update.
        @required
        @httpLabel
        tenantId: TenantId

        /// New tenant name.
        name: TenantName

        /// New tenant description.
        description: TenantDescription
    }

    output := {
        /// The updated tenant.
        @required
        tenant: TenantSummary
    }

    errors: [
        ResourceNotFoundError
    ]
}

// ---------------------------------------------------------------------------
// DeleteTenant - DELETE /tenants/{tenantId} -> 202
// ---------------------------------------------------------------------------

/// Offboards a tenant. Sets DELETING status and starts the provisioning
/// workflow, which runs the cell's stamped tenant delete script in AWS
/// CodeBuild, then transactionally removes the tenant record and frees its
/// slot in the cell. Asynchronous: returns 202 immediately; poll GetTenant
/// until it returns 404 (deleted) or DELETE_FAILED. Rejected with
/// ConflictError while the tenant is in-flight (CREATING/UPDATING/DELETING);
/// allowed from ACTIVE and all *_FAILED statuses regardless of cell status -
/// the delete script is the cleanup path, including when the cell itself is
/// CREATE_FAILED.
@authorizer("vendor-authorizer")
@idempotent
@http(method: "DELETE", uri: "/tenants/{tenantId}", code: 202)
operation DeleteTenant {
    input := {
        /// The tenant to delete.
        @required
        @httpLabel
        tenantId: TenantId
    }

    output := {
        /// The tenant, now in DELETING status.
        @required
        tenant: TenantSummary
    }

    errors: [
        ResourceNotFoundError
        ConflictError
    ]
}

// ---------------------------------------------------------------------------
// ListTenants - GET /tenants[?cellId=] -> 200
// ---------------------------------------------------------------------------

/// Lists tenants with pagination, optionally filtered to a single cell.
/// The cellId filter is a query predicate, not a resource lookup - an
/// unknown cellId yields an empty page, not a 404. Statuses are always
/// current - terminal state is written by the provisioning workflow, not
/// repaired by readers.
@authorizer("vendor-authorizer")
@readonly
@paginated(inputToken: "nextToken", outputToken: "nextToken", pageSize: "maxResults", items: "tenants")
@http(method: "GET", uri: "/tenants", code: 200)
operation ListTenants {
    input := @references([{resource: Cell}]) {
        /// Only return tenants placed in this cell. An unknown cellId yields
        /// an empty page, not an error.
        @httpQuery("cellId")
        cellId: CellId

        /// Pagination token from a previous response.
        @httpQuery("nextToken")
        nextToken: PaginationToken

        /// Maximum number of tenants to return.
        @httpQuery("maxResults")
        maxResults: MaxResults
    }

    output := {
        /// One page of tenants.
        @required
        tenants: TenantList

        /// Token for the next page, absent on the last page.
        nextToken: PaginationToken
    }
}

// ---------------------------------------------------------------------------
// GetResource - GET /tenants/{tenantId}/resource -> 200
// ---------------------------------------------------------------------------

/// Returns the tenant deployment's effective definition and state: source
/// and scripts resolved from the cell's stamped definition, plus lifecycle
/// status, build bookkeeping, and the cellId the definition was resolved
/// from.
@authorizer("vendor-authorizer")
@readonly
@http(method: "GET", uri: "/tenants/{tenantId}/resource", code: 200)
operation GetResource {
    input := {
        /// The tenant whose deployment to fetch.
        @required
        @httpLabel
        tenantId: TenantId
    }

    output := @references([{resource: Cell}]) {
        /// The build input source, resolved from the cell's stamped
        /// definition.
        @required
        source: SourceDefinition

        /// The per-tenant deployment lifecycle scripts, resolved from the
        /// cell's stamped definition (the cell's tenantScripts).
        @required
        scripts: ScriptLocations

        /// Current lifecycle status of the tenant and its deployment.
        @required
        status: LifecycleStatus

        /// Failure detail, populated when status is a *_FAILED value.
        statusReason: String

        /// ARN of the most recent successful tenant-scoped CodeBuild build.
        lastBuildId: String

        /// The cell whose stamped definition applies to this deployment.
        @required
        cellId: CellId
    }

    errors: [
        ResourceNotFoundError
    ]
}

// ---------------------------------------------------------------------------
// UpdateResource - PUT /tenants/{tenantId}/resource -> 202
// ---------------------------------------------------------------------------

/// Re-applies the tenant's deployment: no body - sets UPDATING status and
/// starts the provisioning workflow, which runs the cell's stamped tenant
/// update script in AWS CodeBuild. Asynchronous: returns 202 immediately;
/// poll GetTenant or GetResource for the terminal status. Allowed when the
/// tenant is ACTIVE or UPDATE_FAILED and the cell is ACTIVE; rejected with
/// ConflictError otherwise - from CREATE_FAILED the remediation is delete +
/// recreate, and no tenant build runs against a shared deployment that is
/// mid-change.
@authorizer("vendor-authorizer")
@idempotent
@http(method: "PUT", uri: "/tenants/{tenantId}/resource", code: 202)
operation UpdateResource {
    input := {
        /// The tenant whose deployment to re-apply.
        @required
        @httpLabel
        tenantId: TenantId
    }

    output := {
        /// The tenant, now in UPDATING status.
        @required
        tenant: TenantSummary
    }

    errors: [
        ResourceNotFoundError
        ConflictError
    ]
}
