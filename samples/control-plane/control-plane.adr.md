# Control Plane — Architecture Decision Records

## ADR-001: No placement entity — the 1:1 link needs no join

**Status:** Accepted (folded into ADR-009); the predicted seam is exercised by ADR-012 — placement returns as `tenant.cellId`

**Context:** Early drafts modelled a placement entity linking tenants to
resources, with its own CRUDL API. In the silo model the link is strictly 1:1,
and the resource had to know its tenant anyway (provisioning scripts receive
`TENANT_ID`). The placement stored nothing the resource didn't, mirrored its
status, and pass-through-ed every operation.

**Decision:** Cut it. A placement entity is the evolution seam for
pooled/hybrid models (where it becomes the N:1 join between tenants and shared
resources) — reintroduce it when a pooled variant is actually built rather
than carrying speculative generality in a silo-only sample.

**Consequences:** Fewer entities and operations. ADR-009 later took the same
reasoning one step further and removed the separate resource entity too.

## ADR-002: One shared CodeBuild project with per-execution StartBuild overrides

**Status:** Accepted for the implemented silo baseline; refined by ADR-012
for the cell design, which uses separate shared cell and tenant projects/roles

**Context:** Each tenant carries its own `ProjectSource`. Options: create a
CodeBuild project per tenant (control plane mutates build infrastructure), or
run everything through one shared project using `StartBuild` overrides.

**Decision:** For the silo baseline, one shared CodeBuild project.
`StartBuild` supplies `sourceTypeOverride`, `sourceLocationOverride`,
`buildspecOverride` (inline buildspec that executes `$SCRIPT_PATH`), and
`environmentVariablesOverride` per execution. Verified against the CodeBuild
API reference 2026-09-03. The cell design retains shared projects but splits
cell and tenant builds into two projects with distinct service roles
(ADR-012), because their application-plane permissions differ.

**Consequences:** Tenant records stay pure metadata — no orphaned CodeBuild
projects on offboarding. One IAM service role is the single provisioning
blast radius (documented hardening point). Trade-off: source auth for private
repos is configured at the project level (CodeConnections), not per tenant —
acceptable for a sample; per-tenant `auth` support is a noted extension.

## ADR-003: Cross-service calls forward the caller's vendor JWT

**Status:** Superseded by ADR-009 (no cross-service calls remain)

**Context:** The two-service design needed the tenant service to call the
resource service's API in the request path.

**Decision (historical):** Forward the caller's vendor IdP JWT rather than
introducing M2M client credentials — valid because all cross-service calls
happened in the request path where the token is live.

**Consequences:** The pattern (and its constraint — background workflows have
no live token, see ADR-007) remains the reference approach if the sample is
ever re-split into multiple services.

## ADR-004: The control plane knows only the vendor IdP; customer identity is an application plane decision

**Status:** Accepted (revised — customer IdP removed from the control plane)

**Context:** Earlier drafts took two identity providers as deployment inputs:
the vendor IdP protecting the control plane, and a customer IdP injected as
environment variables into provisioning builds so scripts could configure
application-plane auth. On review, the customer IdP is an **application plane
decision** — which identity provider a silo uses to authenticate its end
users belongs to the silo's own definition, not to control plane
configuration.

**Decision:** The control plane takes exactly one identity input: the vendor
IdP (issuer URL + audience, via CDK context), consumed by the Lambda
Authorizer (JWKS-based JWT validation) on every operation. Customer identity
is entirely the provisioning scripts' concern — a script that needs IdP
configuration carries it in its own source or fetches it itself. The control
plane passes only tenant identity (`TENANT_ID`, `OPERATION`) to builds.

**Consequences:** A cleaner plane boundary: the control plane holds no
application plane configuration of any kind and needs no changes when silo
auth strategies differ per tenant or evolve. Scripts that need per-tenant
customer IdP settings own that problem end to end. The boundary test is
*configuration vs. onboarding input*: `adminEmail` (the first customer
admin, passed to the create script as `ADMIN_EMAIL` for application plane
user bootstrap) is onboarding input that crosses the boundary exactly once —
it is **not persisted** on the tenant record, where it would add no value
after the script has run; it survives only in the workflow execution history
and build logs, which suffice for audit. If a future variant wants the
control plane to carry opaque per-tenant configuration to scripts, the
extension point is a generic `parameters: map<string, string>` field on the
tenant's resource definition, passed through as build environment variables —
deliberately generic, not IdP-shaped.

## ADR-005: Mutations that end in CodeBuild are async (202) via Step Functions

**Status:** Accepted

**Context:** Provisioning scripts run in CodeBuild and may take minutes to
hours (real infrastructure — CloudFormation and the like). Synchronous API
Gateway calls cap at 29 seconds. A plain Lambda waiter was considered and
rejected: Lambda's 15-minute invocation cap is exceeded by exactly the builds
that most need bookkeeping, Lambda bills the entire wait as compute, and a
crash mid-wait loses the terminal transition (no durable execution).

**Decision:** `CreateTenant`, `DeleteTenant`, `UpdateResource` return HTTP 202
after persisting a transitional status (`CREATING`/`DELETING`/`UPDATING`).
A Step Functions workflow runs `StartBuild` with the `.sync` integration
(free while waiting, durable, checkpointed) and writes terminal state.
`GetTenant` is the polling endpoint. `UpdateTenant` is the one synchronous
mutation (metadata only, no build).

**Consequences:** Matches the sync-Lambda/async-Step-Functions convention.
Transitional status doubles as an optimistic concurrency guard: mutations on
an in-flight tenant return 409. No callback/webhook plumbing —
`startBuild.sync` handles completion.

## ADR-006: Control plane data is not tenant-scoped by caller

**Status:** Accepted

**Context:** The usual multi-tenant pattern scopes every operation to the
caller's `tenantId` from the JWT. Here, callers are vendor operators managing
*all* tenants — tenants are the subject of the API, not the caller.

**Decision:** The authorizer validates vendor IdP JWTs and emits a
`CallerContext { operatorId, role }` rather than a tenant-scoped context.
Tenant partitioning in DynamoDB (`PK=TENANT#...`) is retained as the data
layout, keyed by the *target* tenant from the request, not the caller. The
configured issuer is dedicated to the control plane and issues tokens only to
fully privileged vendor operators; the sample intentionally has no
per-operation role matrix.

**Consequences:** The ingress-extracts-context pattern is preserved (handler
is a pass-through, service never sees the raw event), but the context carries
operator identity. `role` is retained for audit and future extension, not
current authorization. A deployment that connects a broader workforce or
customer issuer must add and enforce an explicit role matrix first.
Application-plane services built on top of this sample would use the
conventional caller-tenant-scoped context.

## ADR-007: Cross-service status propagation

**Status:** Superseded by ADR-009 (no propagation needed — single service)

**Context:** In the two-service design, the provisioning workflow finished
minutes after the API returned 202, and the tenant service had to learn the
outcome. Four mechanisms were evaluated:

1. **EventBridge push** — resource service publishes terminal-state events;
   tenant service consumes. No credentials, one bus + rule + Lambda; event
   schema contract, at-least-once delivery.
2. **Caller-driven read-repair** — `GetTenant` polls `GetResource` with the
   live caller JWT and lazily repairs status. Rejected: reads gain side
   effects, `ListTenants` stays stale, and tenant record *removal* becomes a
   side effect of a `GET` — offboarded tenants persist as ghosts unless polled.
3. **Tenant-side polling workflow with the caller JWT** — rejected: the token
   must sit in Step Functions execution state (visible in execution history),
   and provisioning routinely outlasts JWT TTL — expiry mid-poll strands the
   tenant in `CREATING` with no remediation.
4. **Tenant-side polling workflow with M2M client credentials** — sound
   (token fetched per poll, never stored), at the cost of an M2M client on
   the vendor IdP and a Wait-loop state machine.

**Decision (historical):** EventBridge (option 1) as the fewest moving parts
with zero credential management; option 4 the runner-up where demonstrating
service-to-service auth matters.

**Consequences:** ADR-009 dissolved the problem — the workflow and the tenant
table are in the same service, so terminal state is written directly. This
analysis remains the reference if the sample is ever re-split.

## ADR-008: A resource is a provisioned silo instance; its lifecycle runs the scripts

**Status:** Superseded by ADR-012 — the provisioning definition moves from the tenant to the deployment-configured CellDefinition

**Context:** An early draft treated a resource as a reusable template
(source + scripts) provisioned through placements. The silo model simplifies
this: every tenant gets exactly one dedicated resource, defined at onboarding.

**Decision:** The resource *is* the provisioned instance. Its definition
(`source` + `scripts`) is provided in `CreateTenant`. The create/update/delete
scripts are executed by the shared CodeBuild project for the matching
lifecycle operation.

**Consequences:** No template catalogue. Alternative considered: a
deployment-configured default silo definition (CDK context) so `CreateTenant`
needs only a name — rejected as the default because it hides the
`ProjectSource` requirement from the API surface, but trivially added later
as a fallback when `resource` is omitted.

## ADR-009: Single service — the tenant embeds its silo resource

**Status:** Accepted

**Context:** The stated goal is **the simplest correct silo control plane**.
The two-service split (tenant service + resource service) generated all of the
design's hard questions — cross-service auth (ADR-003), status propagation
(ADR-007), service discovery — while the 1:1 relationship meant the resource
had no independent existence: created only with its tenant, deleted only with
its tenant, status mirroring the tenant's. A service boundary that adds
machinery without adding capability is the boundary to remove.

**Decision:** One service, one table, one API. The tenant record embeds the
silo (`source`, `scripts`, `status`, `lastBuildId`). Resource create/delete
have no standalone API — they are `CreateTenant`/`DeleteTenant`. The silo
remains readable and re-applicable as a singleton sub-resource:
`GET /tenants/{tenantId}/resource` and `PUT /tenants/{tenantId}/resource`
(runs the update script). The provisioning workflow writes terminal state
directly to the shared table.

**Consequences:** Seven API operations; zero cross-service calls, zero
propagation machinery, zero discovery. One status field — truthful in a silo
model, where tenant lifecycle is silo lifecycle. What is lost: the sample no
longer demonstrates multi-service control plane composition (service-to-service
auth, event-driven propagation) — those patterns are preserved as reference
analysis in ADRs 003 and 007. **Re-split seam** for pooled/hybrid models:
extract the embedded `ResourceDefinition` into a resource service with
independent lifecycle, reintroduce placement as the tenant↔resource join
(ADR-001), and adopt ADR-007's option 1 or 4 for propagation. The
`/tenants/{tenantId}/resource` sub-path is exactly where that extraction
happens without breaking clients.

## ADR-010: Shared resources are supplied to the application plane via SSM parameters read at deploy time

**Status:** Accepted

**Context:** Silo deployments are rarely 100% isolated — some application
plane infrastructure is shared across tenants (a VPC, a hosted zone / base
domain, a container image repository, an event bus). Provisioning scripts
need references to these shared resources when deploying a silo. Options:
the control plane stores and injects them (as build environment variables),
scripts hardcode them in source, or scripts resolve them at deploy time from
a well-known location.

**Decision:** Shared application plane resources publish their identifiers to
SSM Parameter Store under an agreed namespace (`/application-plane/shared/<name>`).
Create/update scripts read them **at deploy time** during the CodeBuild run
(`aws ssm get-parameter`) and wire them into the silo. The CodeBuild service
role is granted `ssm:GetParameter` on that namespace. The control plane is
not involved in the exchange.

**Consequences:** Consistent with ADR-004's plane boundary — the control
plane carries no application plane configuration; SSM is the contract between
shared infrastructure and silo deployments. Deploy-time resolution means
shared resource changes (e.g. a new image tag) take effect on the next
create/update build with no control plane change and no tenant record
mutation. Scripts fail fast if a required parameter is missing — a clear
`CREATE_FAILED`/`UPDATE_FAILED` with the missing parameter in `statusReason`.
Trade-off: the namespace is an implicit contract; the sample documents it and
ships a demo parameter alongside the sample scripts.

## ADR-011: Resolve workflow inputs before execution and update records by field ownership

**Status:** Accepted

**Context:** The service already reads or creates the tenant record before a
lifecycle transition, but the workflow rereads that mutable record to resolve
the CodeBuild source and script. That duplicate read introduces a
missing-item `States.Runtime` path and expands one build into three branches.
Separately, service read-modify-write `PutItem` calls can overwrite terminal
workflow fields, while lifecycle writes can overwrite concurrent metadata
edits.

**Decision:** The service resolves the operation-specific source, script, and
failure status into the Step Functions execution input. The workflow has one
CodeBuild task, one failure path, and a success choice only for delete versus
active. After initial tenant creation, the service and workflow use DynamoDB
`UpdateItem` expressions to modify only the fields each operation owns.
`StartExecution` rejection is conditionally compensated from the transitional
status to the matching `*_FAILED` status.

**Consequences:** The workflow no longer depends on a second tenant read or a
dynamic script-map lookup. Metadata changes cannot revert status or remove
`lastBuildId`; lifecycle transitions cannot restore stale metadata. Execution
history contains the resolved source and script path, which is acceptable for
operator-visible control-plane data. The service must keep workflow input
construction and lifecycle status mapping together, and compensation itself
remains a best-effort DynamoDB write whose failure is surfaced with the
original start failure.

## ADR-012: Cell-based deployment model with a deployment-configured CellDefinition

**Status:** Accepted (2026-09-07)

**Context:** The silo model gives every tenant a fully dedicated deployment
defined by tenant-supplied `source` + `scripts`. Moving to a cell model — a
shared application deployment per cell plus a per-tenant deployment inside
it, with a maximum tenant count per cell — raises the question of where the
two provisioning definitions (cell-level and tenant-level) live. Options:
keep per-tenant script definitions and add cell scripts separately, or make
the whole definition deployment configuration.

**Decision:** One deployment-configured **CellDefinition**
(`{source, cellScripts, tenantScripts, maxTenants}`, via CDK context),
**stamped onto each cell record at creation**. Every tenant in a cell is
provisioned with that cell's stamped definition; `CreateTenantInput` shrinks
to `{name, description?, adminEmail}`. The cell is the N:1 placement join
predicted by ADR-001/ADR-009 — it returns as an entity and a `tenant.cellId`
field, not as a separate service: the sample stays one service, one table,
one API, and one workflow. Provisioning uses two shared CodeBuild projects:
a cell project whose role owns `/application-plane/cells/*`, and a tenant
project whose role can read cell parameters but cannot mutate them. This
refines ADR-002 for the different permission boundaries introduced by cells.

**Consequences:** Cells are homogeneous by construction — a tenant is
placeable into *any* cell with capacity, which per-tenant provisioning
definitions would break. Stamping makes config changes forward-only: existing
cells keep the definition they were built with; new provisioning *code*
still flows in without a definition change because git sources are fetched
fresh per build. The tenant's `/resource` sub-path survives with new
semantics: `GET` returns the effective (cell-inherited) definition plus build
state, `PUT` (no body) re-applies the tenant deployment. The no-body `PUT`
re-apply (here and on `/cells/{cellId}`) is action semantics carried in a
`PUT` for consistency with the implemented silo baseline; a `POST .../apply`
action path would be the more literal modelling and is a reasonable rename if
the baseline API is ever revised. What is lost:
heterogeneous per-tenant deployments — that is the silo model, preserved in
`architecture.md`'s history. A definition-replacing `UpdateCell` body is a
noted extension, deliberately excluded.

## ADR-013: Implicit cell creation; capacity via an atomic slot claim whose lifetime equals the tenant record

**Status:** Accepted (2026-09-07 — with a bounded candidate loop: at most 5 claim attempts before falling through to new-cell creation, see §6 of the architecture)

**Context:** Cells must be created when onboarding finds no free capacity.
Concurrent onboards can race for the last slot in a cell, race to create
"the" new cell, or place into a cell that is being deleted. A correct design
needs one authoritative occupancy guard and defined slot-release semantics.

**Decision:** No `POST /cells` — cell creation is exclusively a placement
outcome inside `CreateTenant`. Placement is a single `TransactWriteItems`:
a conditional `tenantCount + 1` update guarded by `status = ACTIVE AND
tenantCount < maxTenants` **plus the tenant `PutItem`**, retrying across
candidate cells; if none succeeds, the transaction instead creates a new
cell record (`CREATING`, `tenantCount = 1` pre-claimed) together with the
tenant, and the workflow runs the cell create build before the tenant
create build in one execution. **Slot lifetime = tenant record lifetime,
atomically at both ends**: the claim and the tenant record are born in one
transaction (a service crash cannot leave a phantom slot with no tenant
referencing it), and the only decrement is the delete workflow's terminal
`TransactWriteItems`. That transaction deletes the tenant only when it exists
in `DELETING` and decrements only an existing cell with `tenantCount > 0`.
Those conditions make replays safe even after DynamoDB's finite
`ClientRequestToken` window; a stable token remains short-window protection.
After cancellation, an absent tenant proves that a prior attempt committed,
while a present tenant is moved conditionally to `DELETE_FAILED`. A
`CREATE_FAILED` tenant keeps its slot until deleted. Placement requires the
cell `ACTIVE` — the same condition closes the
place-into-`DELETING`-cell race.

**Consequences:** The counter is trustworthy because exactly two code paths
touch it, both transactional and replay-safe through item-state conditions;
client tokens add short-window duplicate suppression. A transaction
cancellation is treated as a lost placement race only when cancellation
reasons identify the cell status/capacity condition — ambiguous failures never
retarget the same tenant. Tolerated races over-provision but never corrupt:
two no-capacity onboards may create two cells, and onboards arriving while a
cell is still `CREATING` create further cells — accepted, since serialising
cell creation would need a fleet-wide lock for a rare, benign outcome (real
fleets warm capacity ahead of demand, which is out of scope). If
`StartExecution` rejects for a new-cell placement, one transaction moves both
records to `CREATE_FAILED`; cell-build failure uses the same paired failure
transition. A process crash between placement and `StartExecution` remains a
manual-repair gap. Build Tasks have catchable timeouts and terminal-write
failures are caught and routed to the conditional `*_FAILED` transitions —
which shrinks the stranding window but does not eliminate it, since the
failure write is itself a DynamoDB write that can exhaust retries; the
aged-transitional-record sweep noted in the architecture covers both gaps in
production. Cell `CREATE_FAILED` remediation follows the existing cleanup
contract: delete the tenant (frees the slot), then delete the empty cell —
both delete scripts are idempotent and tolerate partial provisioning.

## ADR-014: Cell scale-in is explicit — empty cells persist until an operator deletes them

**Status:** Accepted (2026-09-07)

**Context:** When the last tenant offboards, the cell's shared deployment
could be deprovisioned automatically (tight, no idle cost) or retained until
an operator acts.

**Decision:** The cell stays, empty and `ACTIVE`, and accepts future
placements. `DELETE /cells/{cellId}` is the explicit scale-in operation:
the `DELETING` transition is a **single conditional `UpdateItem`**
(`condition: status IN {ACTIVE, *_FAILED} AND tenantCount = 0`) — the
emptiness check and the transition are one atomic write, the counterpart of
ADR-013's placement claim (a read-then-write would let a concurrent placement
claim a slot before `DELETING` lands); condition failure maps to the 409.
Once accepted, `DELETING` blocks new placement, the workflow runs the cell
delete script, and removes the record with a `tenantCount = 0` conditional
delete as defence in depth.

**Consequences:** `DeleteTenant`'s blast radius stays constant — it never
implicitly tears down shared infrastructure. Idle-cell cost is an operator
decision, visible in `ListCells` (`tenantCount = 0`). The terminal
conditional delete should never fail (the atomic transition already excludes
occupancy). On condition failure, the workflow reads the cell: a missing
record means an earlier attempt committed and is treated as success; a
present record is moved conditionally to `DELETE_FAILED` with a
`statusReason`. The failure write is guarded by `attribute_exists`, so it
cannot resurrect a deleted cell as a ghost item. Auto-scale-in policies (e.g.
delete after N days empty) are a business-plane concern layered on the
explicit API, not built into the control plane.

## ADR-015: Authentication-only gating under the dedicated operator-issuer assumption

**Status:** Accepted (2026-09-07) — amended by ADR-018 (the `role` claim is now enforced as a coarse membership gate; the no-per-operation-matrix decision stands)

**Context:** Every operation requires a vendor IdP JWT, but no operation
checks a role or scope — any authenticated caller can perform any operation.
For a broad trust population that would be an
authenticated-as-authorized flaw. The dangerous variant of that flaw was
eliminated by ADR-012 (callers can no longer supply provisioning code), but
the question remained whether the sample should implement a per-operation
role/scope matrix.

**Decision:** Keep gating on authentication alone, and make the assumption
that justifies it explicit: the configured issuer is a **dedicated
control-plane trust boundary** that issues tokens exclusively to fully
privileged vendor operators (§2 of the architecture). Under that assumption
every authenticated caller IS authorized for every operation, and a
role/scope matrix would gate nothing — it would be configuration surface
with no consumer, inventing requirements the sample does not have. The
`role` claim is carried honestly (present only when the IdP issued it, never
fabricated) for audit and as the extension point.

**Consequences:** Connecting a broader issuer — workforce, customer, or any
population that is not uniformly privileged — requires designing an explicit
role/scope matrix and enforcing it per operation BEFORE deployment;
authentication alone is not sufficient for that trust population. The
extension point is mechanical: the authorizer already forwards `role`, and
`CallerContext` already carries it to every operation. This is a documented
boundary of the sample, not a TODO — there is no half-built gating to
maintain, and no false impression that a partial matrix protects anything.

## ADR-016: Pagination tokens stay unsigned — partition-pinned queries make forged tokens harmless

**Status:** Accepted (2026-09-07)

**Context:** The pagination token is base64url-encoded JSON of DynamoDB's
`LastEvaluatedKey` — readable and forgeable by any caller. The backlog
carried "sign the token" (HMAC or KMS) as a hardening candidate, on the
theory that a forged token becomes a scope bypass if listing is ever
tenant-scoped.

**Decision:** Do not sign. The authenticity concern is structurally moot
because every list path is a **Query pinned to a server-side partition**:
`ListCells` and `ListTenants` query GSI partitions whose key values (`CELL`,
`TENANT`, `CELL#<cellId>`) are set by the service, never by the caller. Per
the DynamoDB Query contract, a query "returns all items with that partition
key value" from the `KeyConditionExpression`; `ExclusiveStartKey` only
positions WITHIN that result set (verified against the API reference,
2026-09-07). A forged token can reposition the caller inside data they may
already page through, or produce a `ValidationException` — which the
repository maps to the modelled 400 — but it can never widen the result set
beyond the queried partition. This argument holds even for a future
tenant-scoped listing, provided the partition value derives from the
caller's verified context (JWT), which is exactly how a tenant-scoped
partition would be built. The one API that took a caller-positioned key
without a partition pin — the Scan-based `Repository.list()`, dead code
since the cell redesign moved all listing to the GSIs — is deleted, so the
property is enforced by construction rather than by convention.

**Consequences:** No signing key to provision, cache, or rotate — material
simplification for a sample. The invariant to preserve is stated where it
matters (repository doc comment): pagination must go through
partition-pinned `Query`; reintroducing an unpinned `Scan` (or deriving the
partition value from caller input rather than verified context) reopens the
question and would justify signed tokens. Tokens remain readable — they leak
key attribute names and one item's key values to the caller who just read
that item, which is not sensitive here.

## ADR-017: CreateTenant idempotency via an optional clientToken and a transactional idempotency record

**Status:** Accepted (2026-09-07)

**Context:** `CreateTenant` is asynchronous but its placement is a
synchronous write: an API Gateway timeout (or network failure) after the
placement transaction commits leaves the client unsure whether the tenant
was onboarded. The natural client reaction — retry — onboards a second
tenant, and possibly a second cell. Stage throttling bounds the blast
radius but not the duplication. Alternatives considered: (a) dedupe on
Step Functions execution name — wrong layer, the duplication happens at the
placement transaction, before `StartExecution`; (b) dedupe on tenant `name`
— names are not unique by design; (c) DynamoDB's transaction
`ClientRequestToken` — a 10-minute idempotency window scoped to identical
request payloads, useful for automatic SDK retries but not for a client
retry that re-runs placement (the retry may pick a different candidate
cell, changing the transaction payload).

**Decision:** An optional `clientToken` on `CreateTenant` (`@idempotencyToken`,
1–64 chars). When present, the service writes an **idempotency record**
(`PK=IDEMPOTENCY#<token>`, `SK=META`, carrying the new `tenantId` and a
SHA-256 hash of the request parameters) as a third item in the SAME
placement `TransactWriteItems` — both the claim-slot and new-cell shapes —
conditional on `attribute_not_exists(PK)`. Detection and the original write
are one atomic transaction; there is no check-then-act window. A cancelled
idempotency condition classifies as a replay (it takes precedence over the
lost-race classification): the service reads the record and returns the
original tenant when the request hash matches — whatever its current
lifecycle status — or the modelled 409 when the hash differs (token reuse
with different parameters), when the tenant was since deleted, or in the
TTL-race corner where the record vanished between transaction and read.
Records carry a 24-hour `expiresAt` for DynamoDB TTL garbage collection;
because TTL deletion is lazy, replay handling ignores `expiresAt` — a
surviving record is authoritative, making the honoured window "at least
24 hours" rather than a hard cutoff. Without a token, behaviour is
unchanged.

**Consequences:** A client retry after a timeout is now safe — same token,
same outcome, no duplicate tenant or cell. The cancellation-reason
classification in the placement transactions gains a third position; the
idempotency item is always appended LAST so its code has a fixed index.
The cost is one extra item per tokenised onboard (self-garbage-collecting
via TTL) and the table's TTL attribute. The idempotency record is
control-plane-owned bookkeeping — it is never listed, never returned, and
carries no GSI keys. `DeleteTenant` deliberately does not clean up the
record: a replayed create after a delete is a 409 pointing at the deleted
tenant, not a silent re-onboard — the safer semantics for an operator API.

## ADR-018: Enforce the `role` claim as a coarse membership gate (threat model M13)

**Status:** Accepted (2026-09-15)

**Context:** ADR-015 kept gating on authentication alone under the
dedicated-issuer assumption, carrying the `role` claim unenforced. The
threat model (T2 issuer misconfiguration, T20 issuer scope creep) showed
that assumption has no code-side backstop: pointing `vendorIdpIssuerUrl` at
a broader issuer — or gradual client/audience reuse on the dedicated one —
silently makes every token holder a control-plane admin. The failure mode
is configuration drift, not an exploit, so it needed a check that fails
closed inside the authorizer.

**Decision:** The authorizer enforces the `role` claim against an allowed
set (`ALLOWED_ROLES` env var, comma-separated, default `operator`). A token
whose `role` is missing or outside the set is denied — never defaulted,
because a fabricated role would grant by omission. `ALLOWED_ROLES` set but
empty (e.g. `",,"`) throws at cold start: an explicit misconfiguration must
not silently widen (fallback) or blankly deny (empty set) access. This is a
coarse membership gate, not the per-operation matrix ADR-015 declined —
every allowed role still holds all eleven operations.

**Consequences:** A misconfigured broader issuer no longer grants admin to
its whole population — only to principals whose tokens carry an allowed
role, which a workforce/customer issuer does not mint by accident. Issuer
scope creep (T20) now requires both a token AND the claim. The IdP must
issue `role: "operator"` on operator tokens (deployment contract, README
checklist). The extension point for a real matrix is unchanged: the claim
is validated at the boundary and carried in `CallerContext`.

## ADR-019: Operator identity flows end-to-end — access logs to build environment (threat model M12)

**Status:** Accepted (2026-09-15)

**Context:** The threat model found two attribution gaps: API Gateway
access logs used `jsonWithStandardFields()`, which omits the authorizer's
`principalId`, so destructive operations were not attributable to an
operator (T9); and application-plane changes made by provisioning scripts
attributed only to the shared fleet CodeBuild roles, with no link back to
the initiating API call (T10).

**Decision:** Thread the verified JWT `sub` through the whole chain. (1)
The API stage uses a custom JSON access-log format including
`$context.authorizer.principalId` — present on Allow AND Deny, so probing
with a valid-but-denied token is also attributable. (2) The service adds
`operatorId` (from `CallerContext`) to the resolved workflow execution
input for all five workflow-starting operations, and the state machine
forwards it to both CodeBuild projects as the `OPERATOR_ID` environment
variable. The Smithy API contract is unchanged — this is internal plumbing
from authorizer context to build environment, preserving the ADR-011
resolved-input discipline.

**Consequences:** Any fleet change now correlates access-log entry
(operator, method, path) → Step Functions execution input (`operatorId`) →
build environment (`OPERATOR_ID`), and provisioning scripts can stamp the
operator into what they provision. `operatorId` is always present in
execution input (empty string never occurs — the authorizer guarantees a
non-empty `sub`). CloudTrail data events remain a deployment-side option;
the sample provides the identity propagation they would correlate with.

## ADR-020: Supply-chain pinning is warn-and-allow — a full commit SHA is the only immutable ref (threat model M10)

**Status:** Accepted (2026-09-15)

**Context:** The provisioning source is fetched fresh by CodeBuild on every
lifecycle build and executed via `bash "$SCRIPT_PATH"` under the fleet
roles. With no ref pinning, a poisoned commit on the default branch is
arbitrary code execution across the fleet on the next lifecycle operation
(T5 — the threat model's highest-consequence open item). The sample had no
way to express an immutable source at all.

**Decision:** `SourceDefinition` gains an optional `sourceVersion`, stamped
per cell like the rest of the definition and forwarded to CodeBuild
StartBuild as `SourceVersion` (a Choice state sends the pinned/unpinned
task variant so an empty string is never passed). Synthesis warns — does
not fail — when `sourceVersion` is absent or not a full 40-character commit
SHA: branches and tags are mutable refs anyone with repo write access can
move, so only a commit SHA counts as pinned. Warn-and-allow because mutable
refs are legitimate during development and this is a sample; the README
hardening checklist makes pinning a production gate.

**Consequences:** A pinned fleet executes exactly the reviewed commit —
compromising the repo no longer changes what existing cells run; the attack
must move to the deployment path (CellDefinition change), which is a
reviewed CDK deploy. Updating provisioning code for pinned cells becomes an
explicit act (new SHA → new/updated cells), which is the point. Unpinned
deployments still work but carry a synth-time warning naming the threat.
Content trust (branch protection, signing, read-only deploy credentials)
remains repository-side — documented in the checklist, not enforceable from
the pipeline.

## ADR-021: Bounded blast radius for amplification and log exposure (threat model M15/M17)

**Status:** Accepted (2026-09-15)

**Context:** Each CreateTenant can create a cell and run up to two
hour-long CodeBuild builds — a leaked token or runaway client is a
cost/concurrency amplification vector (T16). Separately, build logs are
readable by anyone with log-group access, sample scripts echoed fetched
parameter values, and the Lambda/CodeBuild service-created log groups never
expire (T13).

**Decision:** Amplification: `concurrentBuildLimit: 5` on both CodeBuild
projects (excess builds queue rather than fan out) plus two action-less
CloudWatch alarms — state machine `ExecutionsStarted` > 20/5min and API 4XX
> 50/5min — surfacing the abuse signature without SNS plumbing the sample
doesn't need. Log exposure: explicit ONE_MONTH log groups for both Lambdas
and both CodeBuild projects; sample scripts log parameter NAMES, never
values, and never echo `ADMIN_EMAIL` (PII); the convention is codified in
`scripts/CONVENTIONS.md` for provisioning-script authors.

**Consequences:** A token holder inside throttle limits can still spawn
builds, but parallel spend is capped and the attempt alarms within minutes.
Queued builds add latency under legitimate burst load — acceptable at
sample scale, tune the limit for real fleets. Log values age out in a
month; scripts that need to deliver secrets must use SSM
SecureString/Secrets Manager environment integration (masked by CodeBuild),
per the conventions doc. None of this prevents a determined
value-echoing script — the convention is a contract with script authors,
the retention bound is the backstop.
