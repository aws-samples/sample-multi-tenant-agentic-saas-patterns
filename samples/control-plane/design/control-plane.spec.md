# Specification: A Simple Cell-Based Control Plane

> **Status:** This document is the *requirements and principles* layer of
> the control plane design: it states what a correct implementation must do
> and why, without prescribing every implementation detail. An implementer
> (human or LLM) should be able to build a functionally equivalent control
> plane from this spec alone. Where a requirement is a deliberate design
> position rather than an obvious necessity, the reasoning is given inline —
> the spec is also a teaching document.

The keywords MUST, MUST NOT, SHOULD, and MAY are to be interpreted as in
RFC 2119.

---

## 1. Problem Statement

Multi-tenant SaaS providers need a **control plane**: the management layer
that onboards tenants, provisions their infrastructure, tracks lifecycle
state, and offboards them. Most published control plane examples are either
toy CRUD APIs (no real provisioning) or sprawling platforms (dozens of
services obscuring the core ideas).

This spec defines a **simple correct control plane for cell-based
deployments** — small enough to read in a sitting, complete enough to be
correct under concurrency and failure.

### 1.1 The deployment model

A **cell** is the unit of deployment: one **shared application deployment**
plus up to `maxTenants` tenants, each with its **own per-tenant deployment**
inside the cell.

The cell model is a strict generalisation of the two classic isolation
models:

- `maxTenants = 1` → **silo**: every tenant gets a dedicated cell.
- `maxTenants = N` → **cell/pool hybrid**: N tenants share the cell's
  shared deployment, each with its own per-tenant slice.

What "shared deployment" and "per-tenant deployment" mean is entirely up to
the provisioning scripts (see §6) — a deployment is **anything the vendor
can script**: infrastructure provisioning, application bootstrapping,
configuration, data seeding, user setup, or any combination. The one
constraint is time: each script runs inside a build task with a bounded
time budget (R-23), so a deployment must complete within it. Any of these
is a valid instantiation:

| Scenario | Shared (cell) deployment | Per-tenant deployment |
|---|---|---|
| Dedicated resources per tenant | nothing (no-op) | full stack |
| Fully shared resources | full stack | nothing (no-op), or logical setup only |
| Shared infra, dedicated logical resources | database cluster, compute | database on the shared cluster, object store prefix |

"Nothing" is represented by **explicit, idempotent no-op scripts** — never
by omitting the scripts. Every lifecycle path must have a total contract
(see P-9).

### 1.2 What this control plane is NOT

The control plane manages *deployments of* the application plane; it never
becomes part of it. Out of scope, deliberately:

- Billing, metering, tenant tiers
- Cell rebalancing, tenant migration between cells
- Pre-provisioning capacity ahead of demand (auto-scaling the fleet)
- **All application plane concerns — including customer identity.** Which
  IdP a tenant's end users authenticate against is a property of the
  deployed application, owned by the provisioning scripts.

---

## 2. Guiding Principles

These principles generated every decision in the design. When this spec is
silent on a detail, resolve it by applying these principles — they are the
spec's extension mechanism.

### P-1. Minimalism is a correctness strategy, not an aesthetic

Every service boundary, entity, and workflow brings cross-cutting
machinery: auth between services, state propagation, discovery, partial
failure between the parts. A boundary that adds machinery without adding
capability does not belong in the design. Two applications of the principle
here:

- The tenant↔cell relationship is a single field, `tenant.cellId` — not a
  placement entity with its own lifecycle and API. An entity that would
  store nothing its neighbours don't, mirror their status, and pass through
  their operations is a field, not an entity.
- Cells, tenants, and the provisioning workflow live in **one service on
  one table**, so terminal workflow state is written directly — there is no
  cross-service auth, no status-propagation machinery, and no service
  discovery anywhere in the system.

The result: **one service, one API, one table, one workflow, two build
projects.** An implementation of this spec MUST NOT introduce additional
services, tables, or workflows unless a requirement below is unimplementable
without them.

Corollary: when generality is speculative, leave it out and *record the
seam* (§11). For example, the `/tenants/{id}/resource` sub-path is the
extraction point should a standalone resource service ever be needed —
deferred generality is a documented evolution path, not live code.

### P-2. The model is the architecture

The API contract is defined first, in a machine-readable interface model
(Smithy in the reference implementation), and everything else — OpenAPI
spec, server SDK, API Gateway wiring — is *generated* from it. Nobody
hand-edits generated output; the model is fixed and regeneration follows.
This makes the contract the single point of change and keeps implementation
drift structurally impossible.

### P-3. Strict plane separation: the control plane carries no application plane configuration

The control plane knows *that* a tenant exists and *whether* its deployment
succeeded. It does not know *what* the deployment is. Consequences:

- Provisioning is delegated to vendor-supplied **lifecycle scripts** — the
  control plane runs them and records the outcome, nothing more.
- Shared resource identifiers flow from the cell to its tenants through an
  **out-of-band parameter namespace** (SSM Parameter Store), written by cell
  scripts and read by tenant scripts *at deploy time*. The control plane is
  not involved in that exchange.
- Customer identity is an application plane decision.

The boundary test is *configuration vs. onboarding input*: `adminEmail`
(the first application-plane admin user) crosses the boundary exactly once,
as an environment variable to the create script, and is **never persisted**
by the control plane.

### P-4. Cells are homogeneous by construction

Every cell in the fleet is provisioned from the same **CellDefinition** —
a deployment-time configuration bundle (source + cell scripts + tenant
scripts + `maxTenants`) that is **stamped immutably onto each cell record at
creation**.

Why: placement only works if a tenant is placeable into *any* cell with free
capacity. Per-tenant provisioning definitions would break that fungibility.
So tenants carry **no source and no scripts** — their deployment is defined
by their cell's stamped definition.

Stamping makes configuration changes forward-only: a changed CellDefinition
affects only cells created afterwards; existing cells keep the definition
they were built with. New provisioning *code* still reaches existing cells
because git sources are fetched fresh on every build — the definition pins
*where the scripts live*, not their content.

### P-5. Correctness lives in conditional writes — reads only nominate

The single most important consistency principle in the design:

> **Indexes and reads nominate candidates; conditional writes on the
> authoritative record decide.**

- The placement candidate scan reads an eventually-consistent index; a stale
  read can nominate a full or deleting cell. That is fine, because the
  *claim* is a conditional write (`status = ACTIVE AND tenantCount <
  maxTenants`) on the base record that simply fails if the nomination was
  stale.
- Every lifecycle transition is a compare-and-set on the exact expected
  status. A read-time status check is **never** the concurrency guard; a
  failed compare-and-set maps to HTTP 409.
- **No write in the design is unconditional** — even fresh-ULID inserts are
  conditional on non-existence, and metadata/failure writes are conditional
  on existence so they cannot resurrect a concurrently deleted record as a
  ghost.

### P-6. Invariants are protected by atomicity at both ends of their lifetime

The core capacity invariant — *a claimed slot corresponds to exactly one
live tenant record* — is enforced transactionally at both boundaries:

- **Birth:** the slot claim (counter increment) and the tenant record are
  created in **one transaction**. A crash cannot leave a phantom slot with
  no tenant referencing it (a counter that could never be decremented would
  block cell deletion forever).
- **Death:** the tenant record deletion and the counter decrement happen in
  **one transaction** at the end of the delete workflow.

Exactly two code paths touch the counter, both transactional — *that* is
what makes it trustworthy. When you find an invariant in your own design,
count the code paths that can violate it and drive that number to the
minimum, each one atomic.

### P-7. Tolerate benign races; prevent corruption; document the difference

Not every race must be eliminated. The design explicitly classifies races
into two buckets:

- **Corruption** (wrong counter, orphaned records, double-claimed slots) —
  eliminated by P-5/P-6 mechanisms.
- **Over-provisioning** (two concurrent onboards each create a new cell;
  onboards arriving while the only cell is still creating spawn more cells)
  — *tolerated*, because eliminating them would require a fleet-wide lock
  for a rare, benign outcome.

An implementation MUST document its tolerated races and residual failure
windows explicitly (see §8.4). "We accept X because fixing it costs Y and
the impact is Z" is a design output, not an admission of defeat.

### P-8. Long-running mutations are asynchronous: 202 + transitional status + polling

Provisioning runs arbitrary infrastructure code and may take minutes to
hours; synchronous API gateways cap at ~29 seconds. Therefore:

- Every mutation that ends in a provisioning build returns **HTTP 202**
  after persisting a transitional status (`CREATING`/`UPDATING`/`DELETING`).
- A durable workflow engine — not a compute function waiting on the build:
  wait billing, invocation time caps, and crash-loss of the terminal
  transition all disqualify that — runs the build and writes terminal state.
- The read endpoint (`GetTenant`/`GetCell`) is the polling contract.
- **Transitional statuses double as the concurrency guard**: any mutation
  against an in-flight record is a 409. One mechanism serves two purposes.

### P-9. Total contracts: every lifecycle path exists, every failure is a modelled state with a remediation path

- Both script sets (cell + tenant) MUST define all three operations
  (create/update/delete). Empty deployments use explicit no-op scripts —
  never absent ones — so every lifecycle path is executable.
- Every failure lands in a modelled `*_FAILED` status with a
  `statusReason`, and every `*_FAILED` status has a documented operator
  action that leads out of it (retry the update; delete the tenant, then
  the cell). There are no dead-end states.
- Cleanup MUST always be reachable: tenant deletion is allowed from failed
  states *regardless of cell status*, because the delete script is the
  cleanup path even when the cell itself failed to create.

### P-10. Explicit over implicit for operator-facing decisions

- **Scale-out is implicit** (placement creates cells on demand — a
  mechanical decision with a clear trigger), but **scale-in is explicit**:
  an empty cell persists until an operator deletes it. Tearing
  down shared infrastructure as a side effect of the last tenant leaving
  would silently expand `DeleteTenant`'s blast radius.
- The trust model is stated, not implied: the design gates on
  authentication alone *because* the issuer is declared a dedicated
  operator-only trust boundary. A half-built role matrix that
  protects nothing is worse than an honest, documented assumption.

### P-11. Retry safety where retries actually happen

The dangerous retry is the client's: a network timeout after the placement
write commits leaves the client unsure whether onboarding happened, and the
natural reaction — retry — creates a duplicate tenant (and possibly a
duplicate cell). The design addresses this with an **optional client-supplied
idempotency token** whose detection record is written *in the same
transaction* as the placement itself — there is no
check-then-act window. Replays return the original result; token reuse with
different parameters is a 409.

Layered beneath it, infrastructure-level tokens (transaction client request
tokens) protect identical automatic SDK retries — but only within their
finite window. Beyond that window, safety comes from **item-state
conditions** (the delete requires the tenant to exist in `DELETING`; the
decrement requires `tenantCount > 0`), which remain correct forever. Choose
the mechanism that matches the retry's origin and time horizon.

### P-12. Least privilege expressed as role asymmetry

The provisioning scripts are the arbitrary-code surface of the system. The
blast radius is bounded not by reviewing script content but by the IAM
roles they run under — and the roles are deliberately **asymmetric**:

- The **cell build role** may write the cell parameter namespace
  (`/application-plane/cells/*`).
- The **tenant build role** may *read* that namespace but only *write* its
  own (`/application-plane/tenants/*`).

A compromised or buggy tenant script cannot corrupt cell-owned state. The
permission boundary — not throughput — is why there are two build projects
instead of one. These roles are THE hardening point of the whole design.

---

## 3. System Shape

### 3.1 Required components

| # | Component | Requirement |
|---|---|---|
| R-1 | **API layer** | One HTTP API, generated from the interface model (P-2), fronting one service. REST semantics, JSON protocol. |
| R-2 | **Authorizer** | Every operation MUST require a JWT from the vendor IdP (OIDC issuer URL + audience are deployment-time inputs), validated via the issuer's JWKS. There are no unauthenticated operations. |
| R-3 | **Service** | One stateless compute function implementing all operations, including synchronous placement. |
| R-4 | **Store** | One database table holding both entity types (cell + tenant) plus the idempotency record type, with support for multi-item ACID transactions and conditional writes. (The reference uses DynamoDB single-table design; any store with equivalent transactional conditional-write semantics qualifies.) |
| R-5 | **Workflow** | One durable state machine executing provisioning builds and writing terminal state directly to the table. |
| R-6 | **Build runners** | **Two** shared build projects (cell builds, tenant builds) with distinct, asymmetric service roles (P-12). Per-execution overrides select the source and script; the projects themselves are never mutated per tenant or per cell. |

```
Vendor operator ──JWT──► API + Authorizer ──► Service (sync ops, placement)
                                                 │            ▲
                                          202 async ops       │ terminal status
                                                 ▼            │ written directly
                                          Workflow ──► cell build │ tenant build
                                                        (shared projects,
                                                         asymmetric roles)
```

### 3.2 Caller and identity model

- Callers are **vendor operators** managing all tenants. Control plane data
  is NOT tenant-scoped by caller — tenants are the *subject* of the API,
  not the caller. (Application plane services built on top of this design
  would use the conventional caller-tenant-scoped context; this inversion
  is specific to control planes.)
- The authorizer MUST extract caller identity (subject, role claim) into an
  immutable caller context; the handler is a pass-through; the service
  never sees the raw request event. Static configuration (table names,
  ARNs) is initialised once at cold start, separate from per-request
  context.
- Authorization is authentication-only, under an explicit assumption that
  MUST be documented: the configured issuer is a dedicated control-plane
  trust boundary issuing tokens exclusively to fully privileged operators.
  The `role` claim is carried for audit and as the extension point — never
  fabricated, never currently enforced. Connecting any broader issuer
  REQUIRES adding an explicit per-operation role matrix first (P-10).

### 3.3 Deployment inputs

Supplied at deployment time, validated at synthesis/deploy:

| Input | Constraint |
|---|---|
| `vendorIdp.issuerUrl`, `vendorIdp.audience` | non-empty; OIDC discovery must work against the issuer |
| `cellDefinition.source` | `{type, location}` — a build-service source reference (e.g. GitHub repo, S3 bucket); non-empty |
| `cellDefinition.cellScripts` | `{create, update, delete}` — all three paths required, non-empty |
| `cellDefinition.tenantScripts` | `{create, update, delete}` — all three paths required, non-empty |
| `cellDefinition.maxTenants` | integer ≥ 1 |

Changing `cellDefinition` after deployment MUST affect only cells created
afterwards (P-4).

---

## 4. Data Model

One table, two public entity types plus one internal record type. All keys
shown as the reference implementation's convention; the requirement is the
*shape*, not the literal strings.

### 4.1 Cell

| Field | Requirement |
|---|---|
| `cellId` | generated, sortable unique id (ULID) — creation-ordered ids give listings chronological order for free |
| `status` | `CREATING \| ACTIVE \| UPDATING \| DELETING \| CREATE_FAILED \| UPDATE_FAILED \| DELETE_FAILED` |
| `maxTenants` | stamped from deployment config at creation; immutable |
| `tenantCount` | **the authoritative occupancy counter** — see R-20..R-22 |
| `source`, `cellScripts`, `tenantScripts` | stamped CellDefinition; immutable for the cell's lifetime |
| `lastBuildId` | most recent successful cell-scoped build id (nullable) |
| `statusReason` | populated on failure (nullable) |
| `createdAt`, `updatedAt` | timestamps |

Key: `PK=CELL#<cellId>`, `SK=META`.

### 4.2 Tenant

| Field | Requirement |
|---|---|
| `tenantId` | generated ULID |
| `name` | required; NOT unique (uniqueness is deliberately not a tenant-name property) |
| `description` | optional |
| `cellId` | the placement — assigned at onboarding, **never changes** (migration is out of scope) |
| `status` | same enum as cell |
| `lastBuildId`, `statusReason`, timestamps | as for cell |

Key: `PK=TENANT#<tenantId>`, `SK=META`.

**R-7:** The tenant record MUST NOT carry provisioning source or scripts
(P-4). Its effective definition is resolved from its cell.

**R-8:** `adminEmail` MUST NOT be persisted on any record (P-3). It survives
only in workflow execution history and build logs, which suffice for audit.

### 4.3 Idempotency record (internal)

Written only when `CreateTenant` carries a `clientToken`, and only as an
additional item inside the placement transaction — never as a separate
write (P-11).

| Field | Requirement |
|---|---|
| `clientToken` | caller-supplied, 1–64 chars — the item's identity (`PK=IDEMPOTENCY#<token>`) |
| `tenantId` | the tenant the original request onboarded |
| `requestHash` | hash (e.g. SHA-256) of the request parameters — reuse with different input is a 409 |
| `expiresAt` | TTL, ≥ 24h. TTL deletion is lazy, so replay handling MUST ignore `expiresAt` and treat any surviving record as authoritative — the honoured window is "*at least* 24 hours". |

The record is never listed, never returned, and carries no index attributes.
`DeleteTenant` MUST NOT clean it up: a replayed create after a delete is a
409 pointing at the deleted tenant, not a silent re-onboard — the safer
semantics for an operator API.

### 4.4 Listing indexes

Three listing patterns require secondary indexes (reference: two GSIs):

| Pattern | Index shape |
|---|---|
| List all cells / placement candidate scan | static partition (`CELL`) → `CELL#<cellId>` |
| List tenants of one cell | `CELL#<cellId>` → `TENANT#<tenantId>` |
| List all tenants | static partition (`TENANT`) → `TENANT#<tenantId>`, sparse (cells absent) |

**R-9:** Indexes MUST be treated as eventually consistent and **never
authoritative** (P-5). `tenantCount` on the cell record — not an index count
— is the occupancy guard.

**R-10:** Every list query MUST be pinned to a server-side partition whose
key value is set by the service, never derived from caller input. This is
what makes unsigned pagination tokens safe: a forged token can
only reposition the caller *within* a partition they may already read; it
can never widen the result set. Preserve this invariant — reintroducing an
unpinned scan, or deriving a partition value from caller input, reopens the
token-signing question.

Static partitions are an accepted simplicity trade-off at sample fleet
sizes; a production fleet would shard them. Full-attribute projections
(single-query listings, no follow-up reads) are the same trade — trim to
included attributes at scale.

---

## 5. API Surface

Eleven operations. Conventions: lowercase plural collection paths,
kebab-case segments, singleton sub-resource singular. Sync operations
return 200; async (build-triggering) operations return 202 (P-8).

### 5.1 Tenant operations

| Op | HTTP | Code | Contract |
|---|---|---|---|
| `CreateTenant` | `POST /tenants` | **202** | Input `{name, description?, adminEmail, clientToken?}` — **no resource definition** (P-4). Runs placement (§7), starts the workflow, returns the tenant including `cellId`. |
| `GetTenant` | `GET /tenants/{tenantId}` | 200 | The polling endpoint: `status`, `statusReason`, `lastBuildId`, `cellId`. 404 if missing. |
| `UpdateTenant` | `PUT /tenants/{tenantId}` | 200 | Metadata only (`name`, `description`). Synchronous, no build, no state guard — but see R-21 (field ownership). 404 if missing. |
| `DeleteTenant` | `DELETE /tenants/{tenantId}` | **202** | 409 if in-flight. Allowed from `ACTIVE` and all `*_FAILED` states **regardless of cell status** — cleanup must always be reachable (P-9). Runs the tenant delete script; on success the workflow removes the record and releases the slot in one transaction. |
| `ListTenants` | `GET /tenants[?cellId=]` | 200 | Paginated. An unknown `cellId` filter yields an **empty page, not a 404** — a filter is a query predicate, not a resource lookup. |
| `GetResource` | `GET /tenants/{tenantId}/resource` | 200 | The tenant deployment's *effective* definition (resolved from the cell's stamped definition) plus build state. This sub-path is the documented extraction seam if a standalone resource service is ever needed (P-1). |
| `UpdateResource` | `PUT /tenants/{tenantId}/resource` | **202** | Re-apply the tenant deployment: **no body** — runs the stamped tenant update script. Requires tenant `ACTIVE`/`UPDATE_FAILED` **and** cell `ACTIVE`; 409 otherwise. |

### 5.2 Cell operations

| Op | HTTP | Code | Contract |
|---|---|---|---|
| `ListCells` | `GET /cells` | 200 | Fleet topology: `status`, `tenantCount`/`maxTenants` per cell — the operator's capacity view. |
| `GetCell` | `GET /cells/{cellId}` | 200 | Full record including the stamped definition. |
| `UpdateCell` | `PUT /cells/{cellId}` | **202** | Re-apply the shared deployment: no body, runs the stamped cell update script. Allowed from `ACTIVE`/`UPDATE_FAILED`. **409 from `CREATE_FAILED`** — running the *update* script against a half-created deployment breaks the create/update script contract; remediation for a failed cell create is tenant delete + cell delete. |
| `DeleteCell` | `DELETE /cells/{cellId}` | **202** | **Empty cells only** (P-10): the `DELETING` transition MUST be a single conditional write (`status ∈ {ACTIVE, *_FAILED} AND tenantCount = 0`) — the emptiness check and the transition are one atomic write, the counterpart of the placement claim. A read-then-write would let a concurrent placement claim a slot before `DELETING` lands. Condition failure → 409. |

**R-11:** There MUST be no `POST /cells`. Cell creation is exclusively a
placement outcome (§7). An operator API for pre-provisioning capacity is a
noted extension, not part of this spec.

### 5.3 Status state machine (both entity types)

```
            create                     update
  (none) ──────────► CREATING ──ok──► ACTIVE ◄──ok── UPDATING
                        │fail            │  ▲            │fail
                        ▼                │  └────────────┴──► UPDATE_FAILED ──► (update/delete)
                  CREATE_FAILED          │ delete (empty only, for cells)
                        │delete          ▼
                        └──────────► DELETING ──ok──► (record deleted)
                                        │fail
                                        ▼
                                  DELETE_FAILED ──► (delete retry)
```

**R-12:** Every transition into a transitional status (`CREATING`,
`UPDATING`, `DELETING`) MUST be one conditional write (or transaction
member) checking the exact expected/accepted status set (P-5). A failed
compare-and-set maps to 409.

**R-13 — cross-entity guards:**
- Placement requires the cell `ACTIVE` — the single condition that closes
  the place-into-deleting-cell race.
- `UpdateResource` requires the cell `ACTIVE` — no tenant builds against a
  shared deployment mid-change.
- `DeleteTenant` is exempt from cell-status guards (P-9).
- The build guards are one-directional and this is a **documented tolerated
  race** (P-7): a cell build and tenant build can overlap when their
  accepts race. An overlap can fail a build (surfacing as `*_FAILED` on the
  normal retry path) but never corrupts control plane state. Closing it
  would need an in-flight-build counter with the same conditional-claim
  discipline as placement — accepted instead.

### 5.4 Error model

| Error | HTTP | Triggers |
|---|---|---|
| `ValidationError` | 400 | malformed input, malformed pagination token |
| `UnauthorizedError` | 401/403 | missing/invalid JWT |
| `ResourceNotFoundError` | 404 | unknown tenant or cell |
| `ConflictError` | 409 | in-flight mutation; occupied-cell delete; cell-not-ACTIVE guard; `clientToken` reuse with different parameters |
| `InternalServerError` | 500 | everything else |

**R-14:** Repository condition failures MUST be classified, not blanket-500d:
a stale lifecycle transition → 409; a metadata write that loses a
concurrent delete → 404.

---

## 6. Provisioning Contract (Scripts)

Provisioning is delegated to vendor-supplied lifecycle scripts, executed in
the build runners with per-execution source and script overrides. The
control plane's entire contract with them:

### 6.1 Environment contract

| Variable | Cell scripts | Tenant scripts |
|---|---|---|
| `CELL_ID` | ✓ | ✓ |
| `TENANT_ID` | — | ✓ |
| `OPERATION` | `create\|update\|delete` | `create\|update\|delete` |
| `ADMIN_EMAIL` | — | create only (empty string otherwise) |

That's it. No application plane configuration is injected (P-3). If a
future variant wants opaque per-tenant configuration, the extension point
is a generic `parameters: map<string,string>` passed through as environment
variables — deliberately generic, never shaped like any specific concern.

### 6.2 Parameter namespace contract (P-3)

| Namespace | Cell role | Tenant role | Written by |
|---|---|---|---|
| `/application-plane/shared/*` | read | read | shared infrastructure, out of band |
| `/application-plane/cells/<cellId>/*` | read + **write/delete** | read | the **cell create script** publishes the cell's shared resource identifiers here; the cell delete script cleans them up |
| `/application-plane/tenants/<tenantId>/*` | — | read + **write/delete** | tenant scripts own their state here |

Tenant scripts learn their cell via `CELL_ID` and resolve shared resources
from the cell namespace **at deploy time**. Deploy-time resolution means
shared resource changes take effect on the next build with no control plane
change and no record mutation. A missing required parameter fails the
script fast → `*_FAILED` with the parameter named in `statusReason`.

### 6.3 Script requirements

**R-15:** Scripts MUST be idempotent and safe to re-run after partial
completion — the workflow's retry paths (`UpdateCell` after
`UPDATE_FAILED`, `DeleteTenant` retry after `DELETE_FAILED`) re-execute
them. Empty deployments are explicit no-op scripts (P-9).

The scripts are trusted vendor code; the build role policies (§6.2, P-12)
are the documented hardening point that bounds what they can do.

---

## 7. Placement (the heart of the design)

Placement happens **synchronously inside `CreateTenant`**, before the
workflow starts. It embodies P-5, P-6, P-7, and P-11 simultaneously.

### 7.1 Algorithm

```
1. NOMINATE  — read the cell listing index; filter status=ACTIVE AND
               tenantCount < maxTenants; order oldest first.
2. CLAIM     — for each candidate (bounded: at most 5 attempts), one
               transaction:
                 • cell:   tenantCount += 1
                           IF status = ACTIVE AND tenantCount < maxTenants
                 • tenant: insert {status: CREATING, cellId: <candidate>}
                           IF not exists
                 • [idempotency record: insert IF not exists — only when
                    clientToken supplied; always the LAST item so its
                    cancellation index is fixed]
               outcomes:
                 success                       → placed; start workflow
                 idempotency condition failed  → REPLAY (see 7.3) — takes
                                                 precedence over every
                                                 other classification
                 capacity/status cond. failed  → lost a race; next candidate
                 anything else / ambiguous     → FAIL the request; never
                                                 retarget the same tenant
                                                 after an ambiguous
                                                 transaction outcome
3. CREATE    — no candidate claimed (none found, or budget exhausted):
               one transaction:
                 • cell:   insert {status: CREATING, tenantCount: 1
                           (slot PRE-CLAIMED), definition stamped from
                           deployment config} IF not exists
                 • tenant: insert {status: CREATING, cellId: <new>}
                           IF not exists
                 • [idempotency record as above]
               → workflow runs cell create build, then tenant create build,
                 in one execution.
```

**R-16 (nomination vs decision):** step 1's read is an optimisation, never
a guard. Correctness lives entirely in step 2's conditions. Do NOT
"simplify" the claim into a plain write (P-5).

**R-17 (atomic birth):** the claim and the tenant record MUST be created in
one transaction; the new-cell path MUST pre-claim the slot in the same
insert (P-6).

**R-18 (bounded work):** the candidate loop MUST be bounded so `CreateTenant`
stays inside the synchronous gateway window. The miss case — every attempt
loses a race while capacity exists elsewhere — falls through to new-cell
creation: over-provisioning, never a failed onboard (P-7).

### 7.2 Tolerated races (MUST be documented, MAY remain open)

- Two concurrent no-capacity onboards both create a cell → one extra cell.
- Onboards while the only cell is `CREATING` create further cells
  (placement requires `ACTIVE`).
- Oldest-first ordering funnels concurrent claims at the same candidate —
  one cancelled transaction per contended cell before spreading. At
  production scale, randomise candidate order or use power-of-two-choices.
- A cell stuck `UPDATE_FAILED` removes its remaining capacity from the
  fleet until an operator re-runs `UpdateCell`; onboards meanwhile fill
  other cells or create new ones. Visible in `ListCells`.

All over-provision; none corrupts (P-7).

### 7.3 Idempotent replay (P-11)

On a cancelled idempotency condition: read the record and

- request hash matches → return the **original tenant**, whatever its
  current lifecycle status (200-shaped 202 response semantics: same
  outcome as the original call);
- hash differs, or the tenant was since deleted, or the record vanished in
  the TTL race between transaction and read → **409**.

### 7.4 Compensation and the residual gap

**R-19:** if starting the workflow fails *after* the placement transaction,
the service MUST conditionally compensate the exact in-flight state:
existing-cell placement → tenant `CREATING → CREATE_FAILED`; new-cell
placement → **both** records to `CREATE_FAILED` in one transaction (never
leave only one record recoverable). Both land on the documented remediation
path.

**Residual tolerated failure (document it):** a process crash *between* the
placement transaction and workflow start strands the records in `CREATING`
with no workflow running. The transaction guarantees they are mutually
consistent (no phantom slot), but recovery is manual. A production control
plane adds a sweep for aged transitional records; this spec notes it and
deliberately omits it (P-1).

---

## 8. Provisioning Workflow

One durable state machine. Composition over proliferation: `cellBuild` and
`tenantBuild` phases are each optional, and the combination encodes every
operation shape:

| Trigger | cellBuild | tenantBuild |
|---|---|---|
| `CreateTenant` into an existing cell | — | create |
| `CreateTenant` requiring a new cell | create | create |
| `UpdateResource` | — | update |
| `DeleteTenant` | — | delete |
| `UpdateCell` | update | — |
| `DeleteCell` | delete | — |

### 8.1 Resolved input

**R-20:** the service MUST resolve everything the workflow needs — source,
script paths, failure statuses, ids — into the execution input. The
workflow MUST NOT re-read mutable records to decide what to do. Why: a
mid-workflow read of a record that a concurrent operation is mutating
reintroduces exactly the races the conditional writes eliminated, and each
read adds a missing-item failure branch. The execution input is an
immutable snapshot of the decision, taken at accept time. (Execution
history then contains the resolved source/script path — acceptable for
operator-visible control plane data.)

**R-21 (field ownership):** after initial creation, the service and the
workflow MUST update records with expressions touching only the fields each
operation owns — never whole-item overwrites. Metadata edits cannot revert
status or erase `lastBuildId`; lifecycle transitions cannot restore stale
metadata.

### 8.2 Terminal writes

- **create/update success** → compare-and-set in-flight → `ACTIVE` +
  `lastBuildId`.
- **tenant delete success** → **one transaction**: delete the tenant
  (condition: exists AND status = `DELETING`) + decrement the cell counter
  (condition: exists AND `tenantCount > 0`) (P-6). After a committed
  delete, an identical replayed transaction cancels on those conditions
  before changing the counter; the workflow then reads the tenant —
  **absence proves the prior delete committed (success)**, presence is a
  real failure (`DELETE_FAILED`). Item-state conditions, not token windows,
  are the durable replay guard (P-11).
- **cell delete success** → conditional delete (exists AND
  `tenantCount = 0`) as defence in depth; same absence-is-success read on
  condition failure.
- **build failure / task timeout** → compare-and-set from the operation's
  in-flight status to the resolved `*_FAILED` status + `statusReason`. For
  a failed **cell create with a pending tenant create**, one transaction
  moves *both* records to `CREATE_FAILED` (the tenant's reason: "cell
  provisioning failed").

**R-22:** every terminal write retries transient failures; retry exhaustion
is caught and routed through the same conditional `*_FAILED` transition when
the record still exists. This shrinks — but does not eliminate — the
stranding window, because the failure write is itself a write that can
exhaust retries (documented residual, §7.4).

**R-23 (timeouts):** each build task MUST have a catchable task-level
timeout routed to the failure path. The execution-level timeout MUST exceed
the sum of both build budgets plus terminal-write margin — it is a final
safety net, never the normal timeout path (a tripped execution timeout
bypasses the Catch and strands records).

---

## 9. Non-Functional Requirements

| # | Requirement | Rationale |
|---|---|---|
| N-1 | Authorizer result caching MUST use a short, explicit TTL (reference: 60s, not the platform's implicit default). | The cached policy covers the whole API per token; the TTL bounds how long a revoked token retains access. A deliberate trade of cache hit rate for a tighter revocation window. |
| N-2 | The API stage MUST be throttled (reference: 20 rps / 40 burst). | Operations that start builds make a leaked token a **cost-amplification vector**; cap the rate explicitly. |
| N-3 | The table MUST have point-in-time recovery. Sample uses `DESTROY` removal for cleanup; a real control plane RETAINS its tenant registry. | The tenant registry is the system of record. |
| N-4 | Build roles scoped to the parameter namespaces of §6.2 — widen deliberately, per provisioning need. | P-12: this is THE hardening point. |
| N-5 | Pagination tokens are unsigned (see R-10 for the invariant that makes this safe). | No signing key to provision/rotate — material simplification, valid only while R-10 holds. |
| N-6 | Private script sources need source-credential configuration on the build projects (project-level, not per-tenant). | Accepted trade-off: per-tenant source credentials would require per-tenant build infrastructure. |

---

## 10. Acceptance Criteria

A correct implementation demonstrably passes the following end-to-end
scenario against real infrastructure (this mirrors the reference
integration test). With `maxTenants = 2`:

1. **Auth:** an operation without a JWT is rejected; with a valid vendor
   IdP JWT it succeeds.
2. **Implicit creation:** onboarding tenant A with an empty fleet creates
   cell 1 (`CREATING → ACTIVE`), then tenant A (`CREATING → ACTIVE`);
   `GetTenant` reports the `cellId`; the cell namespace
   `/application-plane/cells/<cell1>/*` is populated; the tenant parameter
   exists.
3. **Reuse:** onboarding tenant B places it into cell 1 (no new cell);
   `tenantCount = 2`.
4. **Idempotent replay:** re-sending tenant B's request with the same
   `clientToken` returns the original tenant B (no third tenant, no new
   cell); the same token with different parameters is a 409.
5. **Fill-to-capacity + spillover:** onboarding tenant C creates cell 2
   (cell 1 is full).
6. **Guards:** mutating an in-flight record → 409; `DeleteCell` on an
   occupied cell → 409; `UpdateResource` while the cell is not `ACTIVE` →
   409.
7. **Reads:** `ListCells` shows both cells with correct
   `tenantCount/maxTenants`; `ListTenants?cellId=` filters correctly and an
   unknown cellId yields an empty page; `GetResource`/`GetCell` return the
   stamped definition; `UpdateTenant` edits metadata without touching
   lifecycle fields.
8. **Re-apply:** `UpdateResource` and `UpdateCell` run the respective
   update scripts and return to `ACTIVE`.
9. **Teardown:** deleting all tenants frees their slots
   (transactionally); deleting the now-empty cells removes them; both
   parameter namespaces end empty. Every operation has run at least once.

Plus unit-level assertions that no write path is unconditional (P-5) and
that exactly two code paths mutate `tenantCount` (P-6).

---

## 11. Extension Seams (documented, not built)

Per P-1, deferred generality is recorded as seams, not code:

| Extension | Seam |
|---|---|
| Standalone resource service (pooled/hybrid re-split) | extract at `/tenants/{tenantId}/resource`; introduce a placement entity as the tenant↔resource join; propagate terminal status back via event push or M2M-authenticated polling |
| Definition-replacing `UpdateCell` body | noted extension; today the stamped definition is immutable |
| Explicit capacity pre-provisioning (`POST /cells`) | deliberately absent; placement is the only creator |
| Per-operation authorization matrix | authorizer already forwards `role`; caller context already carries it |
| Opaque per-tenant script parameters | generic `parameters: map<string,string>` → build env vars |
| Stuck-execution sweep for aged transitional records | covers the two documented stranding gaps (§7.4, R-22) |
| Auto-scale-in (delete after N days empty) | business plane policy layered on the explicit `DeleteCell` API |

---

## 12. Reading Order for Implementers

1. §2 (principles) — internalise P-5 and P-6 before writing any data code.
2. §4 + §5 — model the entities and the API contract first (P-2); generate,
   don't hand-write, the API layer.
3. §7 — implement placement with its transactions exactly as specified;
   this is where correctness is won or lost.
4. §8 — the workflow; resolved input and field ownership are not optional
   niceties.
5. §6 + §9 — the script contract and the role asymmetry.
6. §10 — build the acceptance test alongside, not after.

The reference implementation's `architecture.md` and `control-plane.adr.md`
carry the detailed rationale behind each requirement — consult them when a
requirement here seems arbitrary; it almost certainly isn't.
