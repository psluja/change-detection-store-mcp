# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

**Deployed and working** (stack `ChangeDetectionStore` in eu-central-1; end-to-end verified through the Claude connector). All design decisions below are settled — do not re-litigate them without the user.

The repository is not yet a git repository (deliberately, for now).

## What This Project Is

An open-source **change-detection store exposed as an MCP server on AWS**: it stores small JSON objects only when their content hash has changed. A client writes a value under a key in a named store; the service hashes the value and creates a new record only when the hash differs from the last stored one, producing a per-key timeline of real changes.

## Approved Design Decisions

- **Interface:** MCP only (stateless streamable HTTP + OAuth endpoints on one Lambda Function URL). No parallel REST API. Tools: `create_store`, `list_stores`, `delete_store`, `patch_item`, `patch_items`, `get_item`, `list_items`, `get_item_history`, `delete_item`. Agent-friendly semantics (settled): `create_store` is an idempotent upsert returning `{ name, createdAt, created: bool }`; `get_item` on a missing key returns `{ found: false }` (a missing key is a normal state — only a missing STORE is an error); `patch_item` returns `{ changed, hash, date }`; `patch_items` batches 1-50 writes with per-key results `{ key, changed, hash, date } | { key, error }` (a bad item never fails the batch; a missing store does).
- **Sidecar `meta` (settled):** optional JSON field on `patch_item`/`patch_items`, persisted on EVERY call — including `changed: false` (via `updateLatestMeta` port method: condition on hash + liveness, no date bump, no history entry) — but NEVER hashed; replaced whole, ≤ 64 KB. Returned by `get_item` and snapshotted into each history entry. Purpose: often-changing info outside change detection (e.g. `lastSeenAt`).
- **Auth:** OAuth 2.0 with Cognito as the authorization server: hosted UI, app client secret in Secrets Manager, authorization via `cognito:groups` claim (group `cds-allowed`), no self-signup, manual Client ID entry in the Claude connector settings (no DCR). Implemented in `app/src/interface/oauth/`: RFC 9728 + RFC 8414 discovery metadata (base URL derived from the invocation host, never from env), `/auth/authorize` (PKCE S256 required; relay state carries the client's state + redirect_uri; redirect_uri allowlist enforced on BOTH authorize and callback — that closes the open redirect), `/auth/token` proxy (injects the client secret as Basic auth, pins redirect_uri), JWT gate via `aws-jwt-verify` (401 with `WWW-Authenticate: ... resource_metadata=...` vs 403 for missing group). Env: `CDS_USER_POOL_ID`, `CDS_COGNITO_DOMAIN`, `CDS_CLIENT_SECRET_ID` (the secret NAME — a partial ARN as SecretId FAILS IAM evaluation on GetSecretValue, verified in production; clientId+clientSecret live inside this secret), optional `CDS_REQUIRED_GROUP`, `CDS_ALLOWED_REDIRECT_URIS`; `CDS_AUTH_DISABLED=true` only for local dev. Known Function URL quirk: the 401 `WWW-Authenticate` header arrives remapped as `x-amzn-Remapped-www-authenticate` (fixed AWS behavior) — MCP clients rely on the `/.well-known/oauth-protected-resource` fallback, which we serve.
- **Hashing:** SHA-256 over RFC 8785 (JCS) canonical JSON via the `canonicalize` npm package. Object key order and number format never affect the hash; **array order does — that is the client's responsibility** (server never normalizes arrays).
- **Data model (DynamoDB, PK + SK only, no GSI/LSI):** single table.
  - Store registry: PK `STORE`, SK `<name>`
  - Latest state: PK `S#<store>#LATEST`, SK `<key>`
  - History entry: PK `S#<store>#HIST#<key>`, SK `<ULID>`, **TTL always set to date + 30 days**
- **Deletes are soft:** `delete_store`/`delete_item` set `deletedAt` and `ttl = min(existing, now + 7 days)` on all affected records; DynamoDB TTL does physical deletion (lag up to ~48 h), so **every read filters out soft-deleted and expired-but-not-purged records**. `create_store` on a soft-deleted name reactivates it; `patch_item` on a soft-deleted key starts a fresh life (`changed: true`).
- **Validation (settled, security-relevant):** store name `^[a-z0-9_-]{3,12}$` (lowercase only); item key `^[a-zA-Z0-9_|-]{3,32}$` (CASE-SENSITIVE — external IDs like `source|ID6HfGma` must not be lowercased); value ≤ 64 KB serialized. The `#` composite-key separator is excluded from both alphabets by design — do not widen these regexes further.
- **Region:** eu-central-1. **Resource prefix:** `cds`. **License:** MIT.
- **Concurrency:** `patch_item` uses `TransactWriteItems` with a condition on the previous hash PLUS a `ConditionCheck` that the owning store is still live (closes the patch × delete_store race; port result `store-missing` maps to `STORE_NOT_FOUND`).
- **MCP layer:** stateless — one `McpServer` + `WebStandardStreamableHTTPServerTransport` (`enableJsonResponse: true`) per request; the Lambda handler converts Function URL events to fetch `Request`/`Response`. Domain errors map to tool errors as `CODE: message`; unexpected errors are masked as `INTERNAL_ERROR` and logged without item values.
- **Telemetry:** domain metrics via CloudWatch EMF (`EmfTelemetry`, namespace `ChangeDetectionStore` — keep in sync with `APP_METRICS_NAMESPACE` in the api construct): `ToolCalls`/`ToolErrors`/`InternalErrors` (Tool dimension + dimensionless rollup), `ChangesDetected`/`UnchangedCalls`, `AuthUnauthorized`/`AuthForbidden`. No extra Lambdas — the app Lambda emits EMF log lines. The `cds-health` dashboard (monitoring construct) consumes ONLY constructs' `metrics()` and carries English how-to-read text per section + a holistic header; 6 alarms (incl. `InternalErrors ≥ 1`). Per-store granularity would be one added `Store` dimension; per-item analysis belongs in Logs Insights over EMF lines, NOT metric dimensions (cardinality cost).

## Hard Requirements

- **Platform:** AWS. Infrastructure as **CDK in TypeScript**; **Lambda in TypeScript** exposed via **Lambda Function URL** (no API Gateway).
- **Secrets:** everything in Secrets Manager — never in code or config.
- **Helper scripts** for project management via AWS SDK (e.g., create a new user with password) — live in `scripts/`.
- **Language:** all code and comments in English.
- **Architecture:** simplified Clean Architecture with vertical slices. Full SOLID, DI/IoC via constructor injection and a manual composition root (no DI framework). Code must be uniform and machine-predictable across all dimensions. Ports defined in `application`, adapters in `infrastructure`.
- **Security is the top priority.** Structured logs must never contain item values.

## CDK Structure (settled convention)

- Stack(s) live in `infra/lib/`; constructs in `infra/lib/constructs/<area>/` (e.g. `storage/`, `auth/`, `api/`, `monitoring/`).
- **Each construct owns its own isolation, boundaries and permissions** — IAM grants happen inside the construct, never in the stack.
- **Each construct exposes domain metrics as methods**: `public metrics(): XxxMetrics` returning named `() => cloudwatch.IMetric` factories. Dashboards/alarms consume ONLY other constructs' `metrics()` — never reach into raw resources (`this.fn.metricXxx()` is construct-internal).
- CDK feature flags are pinned in `infra/cdk.json` — keep them pinned.

## Repository Layout

- `app/` — Lambda application: `src/domain`, `src/application` (vertical slices), `src/infrastructure`, `src/interface` (mcp + oauth), `src/composition`, `src/lambda.ts`; tests in `test/`.
- `infra/` — CDK app (`bin/app.ts`), stack (`lib/change-detection-store-stack.ts`) and constructs (`lib/constructs/{storage,auth,api,monitoring}/`), each with own grants + `metrics()`; template assertion tests in `test/`.
- `scripts/` — operational scripts (`create-user.ts`, `connection-info.ts`) reading CloudFormation stack outputs.

## Commands

Node.js >= 22 required. Run from the repo root:

- `npm run typecheck` — type-check all workspaces (`tsc --noEmit`)
- `npm test` — unit tests (vitest in `app/`) + CDK stack assertion tests (`infra/test/`; synth bundles the Lambda with esbuild)
- `npm run test:integration` — storage contract tests against DynamoDB Local; auto-starts an `amazon/dynamodb-local` docker container (needs a running docker daemon), or uses `CDS_DYNAMODB_ENDPOINT` if set.
- `npm test --workspace app -- test/app-info.test.ts` — single test file
- `npx vitest run -t "<name>"` (from `app/`) — single test by name
- `npm run lint` — ESLint (flat config, typescript-eslint strictTypeChecked)
- `npm run format` / `npm run format:check` — Prettier
- `npm run dev --workspace app` — local MCP server on http://localhost:3000/mcp (in-memory storage; set `CDS_TABLE_NAME` to use DynamoDB) for MCP Inspector / manual testing
- `npm run synth --workspace infra` — `cdk synth` (feature flags pinned in `infra/cdk.json`)
- `npm run deploy --workspace infra` — `cdk deploy` (requires a bootstrapped account)
- `npm run create-user --workspace scripts -- --email <addr>` — create/complete a Cognito user (password generated if omitted, added to `cds-allowed`)
- `npm run connection-info --workspace scripts` — print MCP URL + OAuth Client ID from stack outputs

CDK notes: the stack registers an AppRegistry application (`ChangeDetectionStore`) and tags every resource with `awsApplication` (plus `Project`/`ManagedBy`/`SecurityProfile`) — this powers the myApplications per-application cost view; activate `awsApplication` and `Project` as cost allocation tags (`aws ce update-cost-allocation-tags-status`, us-east-1) about a day after first deploy. The `infra` workspace relaxes `exactOptionalPropertyTypes` (aws-cdk-lib types are not clean under it) — the `app` workspace keeps it on. The Cognito app client is attached to the auth construct AFTER the function URL exists (`attachCoworkClient`) and its credentials land in a deterministically named secret (`cds/cognito-cowork-client`) read at runtime — do not move clientId into Lambda env (CloudFormation cycle). DynamoDB per-operation throttle/system-error metrics are math expressions sharing inner ids — never place both in one widget/alarm.

Testing pattern: the port contract suite (`app/test/contract/storage-contract.ts`) runs against BOTH adapters — in-memory (unit, `test/contract/`) and DynamoDB (integration, `test/integration/`). When changing port semantics, update the contract suite, never just one adapter. No SQLite adapter by design.

## Possible Future Work (not committed)

Change notifications (DynamoDB Streams → EventBridge → SNS/webhook on `changed: true`), a `diff_item` tool (JSON diff between history entries), per-store retention overrides, a `Store` dimension on the EMF change metrics, CI (lint + tests + synth).
