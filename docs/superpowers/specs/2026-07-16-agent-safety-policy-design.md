# Agent Safety Policy and Approval Architecture

## Status

Approved for implementation planning on 2026-07-16.

## Goal

Turn GGR's auto-chat worker from an independently acting browser script into a backend-governed browser assistant. Electron, `ggr-cli`, and `ggr-mcp` must observe and control the same durable safety state through the local versioned protocol. No client and no worker may bypass risk cooldowns, rate limits, or human approval.

The first phase must prevent a repeat of the observed failure mode: a worker encounters BOSS risk control, exits or restarts repeatedly, and continues generating automated traffic until the account is restricted.

## Current Problems

The repository already centralizes process ownership in `ggr-backend`, but the business safety controls are still fragmented:

- `task-service` owns worker restart behavior, but it does not understand account risk state.
- `auto-chat` owns browsing and sending behavior, so backend clients cannot reliably gate an individual send.
- SageTime uses a coarse process-local counter. Restarting the worker loses its effective history.
- There is no transactional hourly, daily, or company-level chat quota.
- A client can call `task.start` again after a failure and reset the process restart window.
- Risk signals such as a 403 page, CAPTCHA, or invalid login are surfaced as ordinary runtime errors.
- The existing approval queue is JSON-file based and primarily models HR auto-reply review, not an expiring authorization to initiate a chat.
- The worker-to-backend path is currently one-way structured stdout, which cannot carry an approval decision back to the worker.

Random sleeps and Puppeteer stealth settings do not solve these ownership and state problems. Safety decisions must be durable, centralized, and enforceable before the browser action.

## Scope

Phase one includes:

- A backend-owned Safety Policy Engine.
- A durable agent state machine.
- Persistent risk cooldowns with explicit human resume.
- Persistent browse, hourly chat, daily chat, and company cooldown limits.
- Human approval before every new chat.
- A one-time, expiring authorization consumed immediately before sending.
- A bidirectional internal worker control channel.
- Protocol methods, events, CLI commands, MCP tools, and Electron state needed to operate the policy.
- Structured outcomes for successful, failed, and uncertain sends.
- Integration with task restart suppression.
- Migration of approval persistence to the backend SQLite database while preserving existing auto-reply behavior.

## Non-goals

The following are deferred to phase two:

- Attaching Puppeteer to a long-lived interactive Chrome profile.
- Replacing the current browsing loop with a richer human-paced behavior model.
- Trying to evade or bypass BOSS risk controls.
- Automatically clearing an account restriction.
- Automatically sending accumulated approvals when a quota or risk pause ends.
- Performing real BOSS chat sends in automated tests.

## Design Principles

1. **Backend authority:** the backend is the only component that decides whether an action may proceed.
2. **Fail closed:** if the policy store, worker control channel, context validation, or result confirmation is unavailable, the worker must not send.
3. **One shared state:** Electron, CLI, MCP, backend restarts, and worker restarts all see the same persisted state.
4. **No client privilege:** Electron, CLI, and MCP use the same RPC methods. The approving client is recorded for audit, but no client type bypasses policy.
5. **No automatic risk recovery:** risk cooldown expiry makes manual resume eligible; it does not restart the worker.
6. **Conservative uncertainty:** after authorization is consumed, an ambiguous browser outcome counts against quotas and is never automatically retried.
7. **Backward-safe evolution:** older clients may lack the new UI, but they cannot make the backend perform an unsafe send.

## Architecture

```text
Electron ─┐
ggr-cli ──┼── local versioned RPC ──> GGR Backend
ggr-mcp ──┘                              │
                                         ├── Safety Policy Engine
                                         │   ├── Agent State Machine
                                         │   ├── Risk Detector / Cooldown
                                         │   ├── Rate-Limit Ledger
                                         │   └── Approval Service
                                         │
                                         ├── SQLite Safety Store
                                         │
                                         └── Task Service
                                               │
                                      private bidirectional IPC
                                               │
                                         Auto-chat Worker
                                               │
                                            Puppeteer
```

`ggrd` remains the backend process and update supervisor. It does not make job, company, approval, or risk decisions. Electron continues to package only its client UI and protocol client, not backend business code.

## Component Ownership

### Safety Policy Engine

The Safety Policy Engine is a backend service composed by `ggr-backend/server.mjs`. It owns:

- state transitions;
- policy configuration;
- risk records and cooldowns;
- quota checks and reservations;
- approval lifecycle;
- one-time grants;
- send outcome reconciliation;
- public safety and approval RPC handlers;
- safety events published to connected clients.

All mutations run through this service. Clients cannot modify SQLite directly.

### Task Service

The Task Service continues to own worker processes, diagnostics, exit history, and ordinary crash restart limits. It gains two integrations:

- consult the Safety Policy Engine before starting the auto-chat worker;
- host the authenticated-by-parent private IPC channel for the spawned worker.

Task Service must not reset safety state when `task.start` is called. A policy stop is intentional and must set `restartSuppressed: true` without consuming the ordinary crash-restart budget.

### Auto-chat Worker

The worker owns browser mechanics only. It may browse, extract a candidate, validate the current DOM, and report results. It may not decide that a chat is allowed.

Immediately before the existing `newChatWillStartup` send boundary, the worker must:

1. submit a normalized candidate context;
2. wait for human approval;
3. re-read the visible page identity;
4. consume the one-time backend grant;
5. click the approved send target once;
6. report the result.

If any step fails, it must not click send.

## Agent State Machine

The authoritative auto-chat state is persisted by worker scope. Phase one permits only one active auto-chat candidate per worker run.

```text
IDLE
  │ task.start allowed
  ▼
STARTING ───────────────> FAILED
  │ browser ready
  ▼
BROWSING <────────────── EVALUATING
  │ candidate                 ▲
  ▼                           │ reject / expire
WAITING_APPROVAL ─────────────┘
  │ approved
  ▼
SENDING
  │ confirmed or reconciled
  ▼
BROWSING
```

Any active state can transition to:

- `PAUSED_QUOTA` when an action limit is reached;
- `PAUSED_RISK` when a risk signal is detected;
- `STOPPED` after an explicit user stop;
- `FAILED` after a non-risk fatal runtime failure.

State transition invariants:

- Only the backend persists a transition.
- Every transition appends an immutable safety event in the same transaction.
- `PAUSED_RISK` cannot transition to `IDLE` or `STARTING` through `task.start`.
- `safety.resume` is the only transition out of `PAUSED_RISK`.
- A quota window becoming eligible can clear `PAUSED_QUOTA` to `IDLE`, but it never starts a worker or sends a queued action.
- Stopping a worker expires its outstanding candidate and grant.
- Starting a new run never revives an approval from an older `runRecordId`.

## Risk Detection and Circuit Breaker

### Risk signals

The worker-side detector translates browser observations into stable backend risk codes. Initial signals are:

- top-frame navigation or redirect to known BOSS 403/error paths, including the observed `/web/passport/zp/403.html` variants;
- an HTTP 403 on a top-level BOSS navigation;
- known CAPTCHA or security-verification URLs and DOM markers;
- a login redirect, invalid user-info response, `COOKIE_INVALID`, or `LOGIN_STATUS_INVALID`;
- existing `ACCESS_IS_DENIED` failures.

A selector timeout, an empty recommendation list, or a missing job detail is not automatically a risk signal.

### Trip sequence

When the worker detects a risk signal, it sends a synchronous `risk.detected` control request and waits for acknowledgement. The backend then atomically:

1. records the redacted signal;
2. changes state to `PAUSED_RISK`;
3. writes `blockedUntil` when applicable;
4. suppresses worker restart;
5. publishes `risk.detected` and `agent.state_changed`;
6. acknowledges the worker so it can close the browser and exit.

If the IPC channel fails, the worker exits with `SAFETY_CHANNEL_UNAVAILABLE` without sending. Task Service treats that code as restart-suppressed until the backend is healthy and the user starts again.

### Cooldown and resume

- 403, CAPTCHA, and security verification produce a minimum 12-hour cooldown.
- Invalid login produces an indefinite pause until a valid session exists.
- Cooldown expiry does not clear the pause or restart the worker.
- `safety.resume` is rejected before `blockedUntil`.
- After the cooldown, `safety.resume` runs a fresh account/session health check. It transitions to `IDLE` only if the check succeeds.
- A failed resume check appends another event but does not erase or shorten the existing pause.
- There is no `force` flag in phase one.

## Persistent Rate Limits

Initial defaults are:

| Action | Limit | Window |
| --- | ---: | --- |
| Job detail browsed | 100 | Calendar day in configured local timezone |
| New chat reserved | 5 | Rolling hour |
| New chat reserved | 20 | Calendar day in configured local timezone |
| New chat for the same company | 1 | Rolling 24 hours |

The backend stores timestamps in UTC and evaluates calendar-day limits using the configured timezone, defaulting to `Asia/Shanghai`.

Quota behavior:

- A job counts as browsed when its detail is successfully opened and normalized, not when a list item merely appears.
- Chat quotas are reserved in the same transaction that consumes the one-time grant.
- `RESERVED`, `SUCCEEDED`, and `UNKNOWN` chat actions count against limits.
- An action can be released only when the worker proves failure occurred before any click or submit action.
- Any exception during or after the click becomes `UNKNOWN` and continues to count.
- Company identity uses the stable encrypted company ID. If no stable company ID is available, the normalized company name is hashed and used conservatively.
- Repeated requests for the same job are deduplicated by job ID and action type.
- Hitting a limit records `PAUSED_QUOTA` with the earliest eligibility time, stops the current worker intentionally, and does not queue a future send.

The existing SageTime mechanism may remain as a browsing cadence helper, but it is no longer an authority for rate limiting and cannot reset the persistent ledger.

## Human Approval and One-time Grant

### Candidate context

An auto-chat approval contains only the data needed for review and binding:

- worker ID and `runRecordId`;
- encrypted job ID;
- encrypted company ID or fallback company hash;
- recruiter/Boss ID when available;
- job title, company name, area, salary summary, and a bounded JD summary;
- current page URL;
- proposed opening message;
- a canonical `contextHash` over stable identity fields;
- creation and expiration times.

Sensitive cookies, localStorage, raw headers, and full page HTML must never enter an approval or event payload.

### Lifecycle

```text
worker proposes candidate
        │
        ▼
backend pre-checks risk and quota
        │
        ▼
PENDING approval (10-minute expiry)
        │
 Electron / CLI / MCP approve or reject
        │
        ├── reject / expire ──> worker continues browsing
        │
        ▼ approve
backend creates opaque one-time grant
        │
worker revalidates visible page context
        │
worker consumes grant with current context
        │
backend atomically rechecks policy and reserves quota
        │
        ▼
worker may click send once
```

The approving client never receives the grant. The backend returns it only across the worker's private IPC channel. The database stores a hash of the grant, not the plaintext value.

Grant invariants:

- expires no later than 10 minutes after candidate creation;
- bound to approval ID, worker ID, `runRecordId`, and `contextHash`;
- consumed once in a transaction;
- invalidated by stop, worker exit, state change, context change, or risk detection;
- rechecks all quotas and risk state at consumption time;
- cannot be transferred to another job, company, recruiter, page, or run.

Before requesting consumption, the worker must acquire and validate the actual send control. Once consumption succeeds, the worker performs one immediate click. A missing or changed control before consumption is a safe pre-action failure. A click exception or uncertain acknowledgement after consumption is `UNKNOWN` and is never retried automatically.

## Worker Control Channel

Structured stdout remains a diagnostics/event stream. Safety commands use a separate bidirectional Node child-process IPC channel so the worker never reads policy files or SQLite directly.

Request envelope:

```json
{
  "ggrWorkerControl": 1,
  "requestId": "uuid",
  "type": "candidate.propose",
  "data": {}
}
```

Response envelope:

```json
{
  "ggrWorkerControl": 1,
  "requestId": "uuid",
  "result": {}
}
```

or:

```json
{
  "ggrWorkerControl": 1,
  "requestId": "uuid",
  "error": {
    "code": "QUOTA_EXCEEDED",
    "message": "New-chat hourly limit reached",
    "data": { "eligibleAt": "2026-07-16T12:00:00.000Z" }
  }
}
```

Initial internal message types are:

- `agent.state`;
- `browse.record`;
- `candidate.propose`;
- `grant.consume`;
- `chat.result`;
- `risk.detected`.

Task Service derives worker identity and `runRecordId` from the child record. It ignores any identity claimed in the payload. Unknown versions, message types, malformed payloads, and late responses fail closed. Pending requests are cancelled when the child exits.

The same channel will replace direct approval JSON access in the read-no-reply worker. This consolidates approval ownership in the backend without exposing an internal grant method as public RPC.

## Persistence Model

Safety data lives in the existing backend SQLite database and uses repository migrations. The backend shares one initialized data source with records and safety services.

### `ggr_safety_state`

- `scopeKey` primary key, initially `auto-chat`;
- `state`;
- `reasonCode` nullable;
- `blockedUntil` nullable UTC timestamp;
- `updatedAt`;
- optimistic `version`.

### `ggr_safety_event`

- immutable ID and UTC timestamp;
- scope, event type, and severity;
- worker ID and `runRecordId` when applicable;
- redacted JSON payload.

### `ggr_action_ledger`

- action ID and type (`JOB_BROWSED`, `CHAT_RESERVED`);
- status (`RESERVED`, `SUCCEEDED`, `FAILED_PRE_ACTION`, `UNKNOWN`);
- job, company, approval, worker, and run identity;
- reservation and completion timestamps;
- bounded redacted result metadata.

### `ggr_approval_request`

- approval ID and kind (`AUTO_CHAT`, `AUTO_REPLY`);
- status (`PENDING`, `APPROVED`, `REJECTED`, `EXPIRED`, `CONSUMED`, `HUMAN_REQUIRED`);
- canonical context and `contextHash`;
- creation, expiration, review, and consumption timestamps;
- reviewing client identity and optional reason;
- one-time grant hash, never the plaintext grant.

### `ggr_company_cooldown`

- canonical company identity primary key;
- last reserved chat timestamp;
- action and approval IDs that established the cooldown.

Approval and ledger writes use SQLite transactions. Grant consumption starts with an immediate write transaction so simultaneous approvals or clients cannot both pass the same quota check.

### Existing approval migration

On first startup after the schema migration, the backend imports `hr-reply-approval-queue.json` into `ggr_approval_request` as `AUTO_REPLY`. Import is idempotent by legacy ID/dedupe key. The original file is retained as a backup and renamed with a `.migrated` suffix only after the transaction commits. Existing public approval behavior remains available through a SQLite-backed compatibility adapter.

## Public Protocol

The change is additive and remains compatible with protocol version 1. `system.handshake` adds a `capabilities` array containing `safety-policy-v1`; older clients can ignore the extra field. A breaking protocol change would require a new protocol version, but these methods and event names do not.

### New methods

- `safety.status`: current state, reason, eligibility, quota usage, and configured limits.
- `safety.config.get`: read policy limits and timezone.
- `safety.config.update`: validate and atomically update policy configuration.
- `safety.resume`: perform the eligible manual resume and account health check.
- `agent.status`: aggregate task status, policy state, outstanding approval, recent risk, and last exit.
- `approval.get`: get one approval by ID.
- `approval.reject`: reject one pending approval.

### Extended methods

- `task.start` consults safety policy before launching auto-chat.
- `approval.list` accepts optional kind and status filters while retaining `includeAll`.
- `approval.approve` approves according to approval kind. Legacy approvals without a kind retain auto-reply semantics.

The backend attributes review actions from the connection's handshake client identity (`electron`, `ggr-cli`, or `ggr-mcp`) and version. A caller-supplied actor field is rejected.

### Events

- `agent.state_changed`;
- `approval.required`;
- `approval.approved`;
- `approval.rejected`;
- `chat.sent`;
- `chat.failed`;
- `chat.unknown`;
- `quota.blocked`;
- `risk.detected`;
- `risk.cleared`;
- existing `task.progress` and `task.exited`.

Events are live notifications, not the source of truth. Reconnecting clients call `agent.status`, `safety.status`, and `approval.list` to rebuild their view.

### Stable error codes

- `RISK_COOLDOWN_ACTIVE` with reason and `blockedUntil`;
- `LOGIN_REQUIRED`;
- `QUOTA_EXCEEDED` with action, limit, usage, and `eligibleAt`;
- `APPROVAL_NOT_PENDING`;
- `APPROVAL_EXPIRED`;
- `APPROVAL_ALREADY_CONSUMED`;
- `APPROVAL_CONTEXT_CHANGED`;
- `SAFETY_RESUME_REJECTED`;
- `SAFETY_CHANNEL_UNAVAILABLE`.

Errors must not include cookies, session data, grants, full URLs with sensitive query parameters, or unbounded page content.

## Client Surfaces

### CLI

```text
ggr safety status
ggr safety config
ggr safety resume
ggr approvals list
ggr approvals show <id>
ggr approvals approve <id>
ggr approvals reject <id>
```

Commands call `ggr-client`; they do not spawn a daemon or read policy storage.

### MCP

MCP exposes safety status, approval listing/details, approve/reject, and explicit resume as thin tools over `ggr-client`. Tool results preserve stable backend codes and eligibility timestamps. MCP must not add an automatic approval or resume loop.

### Electron

Electron displays the authoritative agent state, quota usage, risk reason/cooldown, and one current auto-chat approval. Approve and reject buttons call the same protocol methods. `PAUSED_RISK` must be visually distinct and must not present ordinary Start as a way to clear it.

## Restart and Exit Semantics

Task Service classifies exits into:

- user stop;
- policy stop (`PAUSED_RISK` or `PAUSED_QUOTA`);
- expected completion;
- unexpected runtime failure.

Only unexpected runtime failures enter the existing rolling restart circuit breaker. A policy stop persists `restartSuppressed: true`, its reason code, and the authoritative safety state in `task.exited` and exit history.

Calling `task.start` never clears restart history or safety state before the safety preflight succeeds. Repeated Start calls during a pause return the same typed policy error and create no child process.

## Failure and Recovery Rules

- `chat.sent` is recorded only after a positive page acknowledgement.
- A proved failure before send control activation becomes `FAILED_PRE_ACTION`; the reservation may be released.
- Any error during or after click becomes `UNKNOWN`; it consumes quota and company cooldown.
- `UNKNOWN` is visible to clients and requires human inspection. It is never automatically retried.
- Backend shutdown expires all run-bound grants. On restart, uncompleted consumed grants reconcile to `UNKNOWN`.
- Worker exit expires pending approvals for that run.
- SQLite unavailable or transaction failure blocks start/approval/send and never falls back to process-local counters.
- Risk detection takes precedence over selector, navigation, and close errors.
- Browser close errors are recorded but cannot trigger a restart from `PAUSED_RISK`.

## Testing Strategy

### Unit tests

- Every valid and invalid state transition.
- Twelve-hour and indefinite risk cooldown behavior.
- Manual resume eligibility and health-check failure.
- Rolling-hour, calendar-day/timezone, and company cooldown calculations.
- Atomic quota reservation and release rules.
- Approval deduplication, expiry, rejection, grant hashing, binding, and one-time consumption.
- Context canonicalization and mismatch rejection.
- Redaction of sensitive event and error payloads.

### Concurrency tests

- CLI and MCP approve the same request concurrently: one transition succeeds.
- Two grants attempt the fifth/sixth hourly reservation concurrently: only the eligible one succeeds.
- Duplicate worker control requests are idempotent by request/action ID.
- Worker exit races with approval: no grant remains usable.

### Protocol tests

- New methods, parameter allowlists, stable errors, and event constants.
- Handshake capability advertisement and compatibility with an older client.
- Client identity attribution comes from handshake context, not request parameters.

### Task/worker integration tests

- `task.start` creates no process during risk or quota pause.
- Risk IPC persists state before worker exit and suppresses restart.
- A candidate cannot reach the send hook before approval and grant consumption.
- Expired, reused, wrong-run, and context-mismatched grants cannot send.
- An IPC failure fails closed.
- Existing runtime-error and exit-diagnostic behavior remains intact.

### Puppeteer DOM tests

Local fixtures model:

- a normal candidate and send control;
- a changed job/company context after approval;
- a 403 page;
- CAPTCHA/security verification;
- login redirect;
- positive, negative, and ambiguous send acknowledgements.

Tests may assert click counts against fixtures. They must not send a real BOSS chat. A real-site test is a separate manually authorized operation and defaults to browse/candidate creation only.

### Migration tests

- New database creation.
- Upgrade from the current schema.
- Idempotent legacy approval JSON import.
- Crash before and after migration commit.
- Existing records, auto-reply approvals, and account status remain readable.

## Rollout

1. Add schema migrations and the SQLite safety repository behind tests.
2. Add the Safety Policy Engine and public read-only status APIs.
3. Integrate task start/restart suppression.
4. Add the private worker IPC channel and risk trip path.
5. Gate auto-chat at `newChatWillStartup` with approval and grant consumption.
6. Migrate the existing approval queue and adapt read-no-reply.
7. Add CLI and MCP surfaces.
8. Add Electron state and approval UI.
9. Deploy with auto-chat stopped.
10. Verify status, migration, risk fixtures, and approval-only real browser behavior before any separately authorized live send.

## Phase Two Direction

After phase one is stable, the browser layer can adopt a persistent Chrome profile and a richer browsing state model. Those changes remain downstream of the Safety Policy Engine: a more human-operated browser still cannot exceed quotas, ignore risk state, or send without approval.
