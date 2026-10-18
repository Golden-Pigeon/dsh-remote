# Remote development wire protocol

- **Status**: v1, implemented by `dsh-remote-agent` and `@dsh-remote/protocol`
- **Transport**: HTTP/1.1 over an SSH local forward; Server-Sent Events for streamed frames
- **Encoding**: JSON envelopes; UTF-8
- **Scope**: host/workspace/session projections plus a small session/workspace write surface. No arbitrary shell or file-content access.

## Why this protocol exists

The design document left the choice between reusing DSH's `/api/remote.mux` and adding an envelope
open. ADR-001 records the decision: the implementation uses a small agent-owned JSON/SSE protocol because its
hosts are independent processes that may run different DSH versions, and Typert descriptors are
generated from a Host TypeScript program at build time. The local browser↔Host link still uses DSH
Connection's authenticated `/api` transport.

## Endpoint base

```text
http://127.0.0.1:<remote-port>/dsh-remote-agent/api/v1
```

The remote agent is served by the remote DSH web host. It is reached through a local SSH forward:

```text
127.0.0.1:<local-port>  ──ssh -L──▶  127.0.0.1:<remote-port>
```

The agent binds no TCP listener of its own. It registers a route on the remote DSH web server, which
must stay on loopback.

## Authentication and negotiation

Every request requires:

```http
Authorization: Bearer <agent-token>
x-dsh-remote-protocol: 1
x-dsh-remote-host-id: <logical-host-id>   # optional, defaults to "local"
x-dsh-remote-request-id: <uuid>           # optional, echoed for tracing
```

The agent requires a loopback peer when `loopbackOnly` is true. A missing or wrong token yields
`401`; a non-loopback peer yields `403`; an unsupported revision yields `409` with
`protocol/version-mismatch`.

The agent advertises its revision on every response:

```http
x-dsh-remote-server-protocol: 1
x-dsh-remote-agent-version: 0.2.1
x-dsh-remote-host-id: <echoed or local>
x-dsh-remote-request-id: <echoed or generated>
```

### Version rules

- `PROTOCOL_VERSION = 1` is the only supported revision.
- A mismatch is a hard failure. There is no silent downgrade.
- The client must call `health` and validate the revision before displaying remote state.
- The agent version and DSH version are informational; the protocol revision is the compatibility
  gate.

## Envelopes

Success:

```json
{
  "ok": true,
  "protocolVersion": 1,
  "serverTime": "2026-10-18T08:23:39.352Z",
  "data": {}
}
```

Failure:

```json
{
  "ok": false,
  "protocolVersion": 1,
  "serverTime": "2026-10-18T08:23:39.352Z",
  "error": {
    "code": "auth/invalid",
    "message": "invalid bearer token",
    "retryable": false,
    "details": {}
  }
}
```

| Code | HTTP | Meaning |
|---|---|---|
| `protocol/version-mismatch` | 409 | Peer revision is missing/invalid/unsupported |
| `auth/missing` | 401 | No bearer token |
| `auth/invalid` | 401 | Wrong bearer token |
| `auth/forbidden` | 403 | Peer is not loopback (when enforced) |
| `request/invalid` | 400/405 | Bad method, limit, cursor, or host header |
| `request/too-large` | 413 | Snapshot scan ceiling exceeded |
| `route/not-found` | 404 | Unknown path |
| `workspace/not-found` | 404 | Workspace not registered |
| `session/not-found` | 404 | Session not live or persisted |
| `session/not-live` | 409 | Follow requested for a cold session (cold resume is not implemented) |
| `agent/not-ready` | 503 | Listener not bound |
| `internal` | 500 | Unexpected agent failure |

`retryable` is advisory. The local plugin reconnects on `agent/not-ready`, transport failures, and
tunnel exits, not on authentication or protocol errors.

## Routes

| Method | Path | Result |
|---|---|---|
| `GET` | `/health` | `HostInfo` |
| `GET` | `/host` | `HostInfo` (alias) |
| `GET` | `/workspaces` | `{ workspaces: RemoteWorkspace[] }` |
| `GET` | `/sessions` | `{ sessions: RemoteSessionSummary[] }` |
| `GET` | `/workspaces/:workspaceId/sessions` | `{ sessions }` filtered to the workspace |
| `GET` | `/sessions/:sessionId?limit=N` | `SessionSnapshot` |
| `GET` | `/sessions/:sessionId/events?cursor=N` | `text/event-stream` |
| `GET` | `/web-url` | `{ path: "/?token=..." }` |

Read routes use `GET`. `GET /approvals/events` is an SSE approval-question stream. Write routes use
`POST` with a JSON body:

| Method | Path | Body | Result |
|---|---|---|---|
| `POST` | `/workspaces` | `{ "path": "/abs/dir", "title"?: "…" }` | `RemoteWorkspace` |
| `POST` | `/sessions` | `{ "workspaceId"?: "…", "cwd"?: "/abs/dir", "agentPreset"?: "…" }` | `CreateSessionResult` |
| `POST` | `/sessions/:id/prompt` | `{ "text": "…", "mode"?: "queue" \| "steer", "provider"?: "…", "model"?: "…", "reasoningEffort"?: "…" }` | `{ "accepted": true }` |
| `POST` | `/sessions/:id/cancel` | `{}` | `{ "accepted": true }` |
| `POST` | `/approvals/answer` | `{ "id": "…", "outcome": "allowed-once" \| "rejected" \| "cancelled" \| "unavailable" }` | `{ "accepted": true }` |

`workspaceId` and `cwd` are mutually exclusive. Prompt text must be non-empty. An optional provider/model
selection is installed on the remote Session before the prompt. A wrong method for a route returns
`405`; unknown paths return a JSON `route/not-found` envelope.

The write surface is deliberately limited: it creates workspaces and sessions, submits prompts, and
cancels a turn. It cannot execute arbitrary commands or read files outside the remote DSH APIs.

## Approvals

`GET /approvals/events` sends `ready`, then one `request` frame per pending approval. Pending
questions are replayed when a follower connects. Each request carries the remote Session id, tool
name, optional call id/reason, and localized display text. The local plugin forwards it through the
local `approval/request` waterfall and posts the decision to `/approvals/answer`.

## Host identity

```ts
interface HostInfo {
  hostId: string          // logical id supplied by the client (optional header) or "local"
  hostname: string
  platform: string
  arch: string
  dshVersion: string
  agentVersion: string
  home: string            // remote DSH home
  startedAt: string       // ISO-8601
  protocolVersion: number
  capabilities: AgentCapability[]
  workspaceCount: number
}
```

`hostId` is a client-side identity. The agent echoes the header so a multi-host client can keep its
caches unambiguous.

## Workspaces

```ts
interface RemoteWorkspace {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}
```

This is the remote registry projection. Session membership is whatever the remote
`ctx.workspaceRegistry` reports; the local client never synthesizes membership from cwd.

## Sessions

```ts
interface RemoteSessionSummary {
  sessionId: string
  workspaceId: string | null
  cwd: string | null
  createdAt: string
  live: boolean
  eventCount: number | null
}
```

The agent lists sessions from the workspace registry plus persisted sessions that are not in a
workspace (reported with `workspaceId: null`). `live` means the session is in the remote process
store. `eventCount` comes from the live store or the persistence snapshot's cheap metadata.

### Snapshot

```ts
interface SessionSnapshot {
  hostId: string
  sessionId: string
  cursor: number          // next expected sequence number
  live: boolean
  workspaceId: string | null
  cwd: string | null
  events: RemoteSessionEvent[]
  truncated: boolean
}
```

- `limit` defaults to 500 and is capped by the agent (2,000).
- The snapshot contains the **newest** page; older events are omitted and `truncated` is true.
- Message events retain `surfaceOp` and `sourceEventSeqs` when the Host event carries them. A native
  mirror uses this metadata to replay the remote log into a local `Session` without losing surface
  placement.
- A cold session is read through `sessionPersistence`; a live session through its in-memory
  snapshot.
- `cursor` is the next sequence number, not the last event's sequence.

### Event stream

`GET /sessions/:id/events?cursor=N` returns SSE. Frames are JSON payloads with an `event:` name:

```text
event: ready
data: {"type":"ready","hostId":"example-host","sessionId":"s-1","cursor":3,"live":true}

event: event
data: {"type":"event","cursor":4,"event":{"seq":3,"type":"turn/start","time":...,"data":{...}}}

event: heartbeat
data: {"type":"heartbeat","cursor":4,"time":...}

event: end
data: {"type":"end","cursor":4,"reason":"session-closed"}
```

Rules:

- The first frame is always `ready`.
- The agent replays the missing suffix from `cursor`, then streams live events.
- Duplicate events are filtered; a forward gap ends the stream with `reason: "error"` and the client
  must request a new snapshot.
- Heartbeats keep intermediaries from idling out.
- The stream is a projection; attaching or replaying it never executes a tool call. Writes only happen through the explicit POST routes above.
- `cursor > session.seq` is rejected with `request/invalid`; a stale but valid cursor replays.

### Cursor rules

A cursor is the next expected `seq`. `EventCursor` (in `@dsh-remote/protocol`) provides:

- `applied` when `seq === cursor`;
- `duplicate` when `seq < cursor` (ignore);
- `gap` when `seq > cursor` (snapshot repair required).

The local mirror applies the same cursor rules when it replays remote events.

## Web URL

`/web-url` returns a browser-authenticated path on the remote DSH origin. The local plugin rewrites
the origin to its tunnel and opens the result. The path contains a short-lived launch token; it is
never logged or stored by the local plugin.

## Write-surface guarantees

- Every write route is authenticated by the same bearer token and loopback check as the reads.
- `session.create` joins an existing workspace or an explicit remote directory; it never creates an
  arbitrary local path outside the remote DSH workspace registry.
- `session.prompt` submits text and an optional model selection. Attachments, file content, terminal
  input, and direct file writes are not part of this protocol. Approval questions travel on the
  dedicated approval stream; the local UI's decision is posted back to this agent. A prompt can still
  cause the remote DSH agent to use its own tools under the remote sandbox and approval policy.
- The bearer token grants session-writing capability. Treat it as a secret and keep the agent on
  loopback.
- `session.cancel` only cancels the active turn of an existing live session.

## Security notes

- The route is not protected by DSH's `/api` browser fence; it has its own bearer token.
- `loopbackOnly` should remain true. A reverse proxy that terminates authentication can justify
  disabling it; a direct public port cannot.
- State files are written atomically with `0600`.
- The protocol never carries model credentials.
- The agent's write surface is session/workspace creation, prompts, cancel, and approval answers.
  Terminal and file traffic for the native UI is carried by the local plugin's SSH adapter, not this
  HTTP protocol.
- Adding another mutation verb requires a protocol revision and a re-review of this boundary.
