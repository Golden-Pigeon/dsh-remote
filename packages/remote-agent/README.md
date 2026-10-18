# dsh-remote-agent

A remote DSH plugin that exposes the remote host's workspaces and sessions to the local plugin.

## What it does

- Registers `/dsh-remote-agent/api/v1` on the remote DSH web server.
- Generates and stores a bearer token in `$DSH_HOME/remote-agent/agent.json` (mode `0600`).
- Projects host identity, workspaces, sessions, and session snapshots.
- Streams committed session events over SSE, including surface placement metadata for native replay.
- Creates workspaces, creates sessions, submits text prompts with optional model selection, and cancels active turns.
- Writes its live port into the state file so the local plugin can discover it over SSH.

It does not expose arbitrary shell execution, file contents, terminal input, or terminal control.
Approval questions are forwarded through the agent approval stream so the native local UI can answer
them. The remote browser UI is intentionally not exposed by default.

## Install

Normally the local plugin installs this package for you when you add a host. For a manual install:

```sh
node packages/installer/lib/cli.js install --target user@host
# or
dsh plugin --profile web add ./dsh-remote-agent-0.2.0.tgz
dsh web --host 127.0.0.1 --port 0 --no-open
```

## Endpoints

Read and write routes are documented in [`docs/protocol.md`](../../docs/protocol.md):

- `GET /health`, `/host`, `/workspaces`, `/sessions`, `/sessions/:id`, `/sessions/:id/events`, `/web-url`, `/approvals/events`
- `POST /workspaces`, `/sessions`, `/sessions/:id/prompt`, `/sessions/:id/cancel`, `/approvals/answer`

## Configuration

See [`cordis.patch.yml`](cordis.patch.yml) and
[`examples/remote-agent.patch.yml`](../../examples/remote-agent.patch.yml).
