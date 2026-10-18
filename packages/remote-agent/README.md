# dsh-remote-agent

A remote DSH plugin that exposes a read-only, loopback-only agent API.

## What it does

- Registers `/dsh-remote-agent/api/v1` on the remote DSH web server.
- Generates and stores a bearer token in `$DSH_HOME/remote-agent/agent.json` (mode `0600`).
- Projects host identity, workspaces, sessions, session snapshots, and live session events (SSE).
- Writes its live port into the state file so the local plugin can discover it over SSH.
- Never executes tools, mutates sessions, or exposes file contents.

## Install

```sh
node packages/installer/lib/cli.js install --target user@host
```

Or manually into a remote profile:

```sh
dsh plugin --profile web add ./dsh-remote-agent-0.1.0.tgz
dsh web --host 127.0.0.1 --port 0 --no-open
```

## Endpoints

See [`docs/protocol.md`](../../docs/protocol.md). Quick check:

```sh
TOKEN=$(cat ~/.dsh/remote-agent/agent.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
PORT=$(cat ~/.dsh/remote-agent/agent.json | python3 -c 'import json,sys; print(json.load(sys.stdin)["port"])')
curl -H "Authorization: Bearer $TOKEN" -H 'x-dsh-remote-protocol: 1' \
  "http://127.0.0.1:$PORT/dsh-remote-agent/api/v1/health"
```

Do not paste the token or the state file into logs or tickets.

## Configuration

See [`cordis.patch.yml`](cordis.patch.yml) and
[`examples/remote-agent.patch.yml`](../../examples/remote-agent.patch.yml).
