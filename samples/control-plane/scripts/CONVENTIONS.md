# Provisioning Script Conventions

Conventions for authoring cell and tenant provisioning scripts run by AWS
CodeBuild. Everything a script prints lands in the build's CloudWatch log
group, readable by anyone with log-group access. Treat build logs as an
audience, not a scratchpad — a script that echoes fetched values turns the
log group into an unintended secrets store.

## Log hygiene

- **Never use `set -x`.** Trace mode prints every expanded command line,
  including fetched parameter values, credentials in CLI arguments, and
  request payloads. Use `set -euo pipefail` only.
- **Never echo parameter or secret values.** Log the parameter NAME or path
  and a success/failure status instead:

  ```bash
  # Good — name and status only
  echo "Wrote /application-plane/cells/${CELL_ID}/shared-endpoint"

  # Bad — the value is now permanently in CloudWatch Logs
  echo "Endpoint is ${CELL_SHARED_ENDPOINT}"
  ```

- **The same applies to derived values** (URLs assembled from fetched parts,
  connection strings, tokens) and PII (email addresses, names). If the value
  wasn't safe to publish, neither is anything computed from it.
- **AWS CLI output counts as log output.** Suppress or narrow it: use
  `--query`/`--output text` into a variable, or redirect to `/dev/null` when
  you only need the exit status. Never let `get-parameter` print its full
  JSON response (it contains the value).

## Secret delivery

- Deliver secrets to builds via SSM SecureString or Secrets Manager
  references in the CodeBuild environment (`parameter-store:` /
  `secrets-manager:` env types). CodeBuild masks these values in the build
  log automatically — plaintext env vars and inline `get-parameter` values
  are not masked.
- Never pass secrets as plaintext environment variables or command-line
  arguments defined in the CellDefinition.

## Failure behaviour

- Exit non-zero on any failure — `set -euo pipefail` plus
  `: "${VAR:?VAR env var is required}"` guards for required inputs. The
  workflow maps a non-zero exit to `CREATE_FAILED`/`UPDATE_FAILED`/
  `DELETE_FAILED`; a script that swallows errors leaves the control plane
  believing provisioning succeeded.
- On failure, name the resource or parameter that failed (name, not value)
  so the build log is diagnosable without re-running.

## Scope

These conventions apply to every script referenced by a CellDefinition
(`cellScripts` and `tenantScripts`). The samples in `sample-cell/`,
`sample-tenant/`, and `sample-noop/` follow them and are the reference
implementations.
