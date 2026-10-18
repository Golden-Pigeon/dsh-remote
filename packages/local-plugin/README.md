# dsh-remote-local-plugin

The local DSH plugin for remote development.

## What it does

- Maintains a durable host registry at `$DSH_HOME/remote/hosts.json` (mode `0600`).
- Discovers the remote agent over SSH by reading its private state file.
- Opens one loopback SSH tunnel per host (`ssh -N -L 127.0.0.1:…`) and health-checks the agent.
- Reconnects with exponential backoff; a manual disconnect suppresses reconnection.
- Projects remote workspaces, sessions, and session snapshots.
- Registers model tools for the same operations.
- Exposes an authenticated host API at `/api/dsh-remote` through DSH Connection's Fetch route.
- Registers **Settings → 远程开发** with host cards, workspace/session browsing, and remote UI launch.

## Install

```sh
cd packages/local-plugin
npm pack
dsh plugin --profile desktop add ./dsh-remote-local-plugin-0.1.0.tgz
```

Quit DSH Desktop before installing and reopen it afterwards.

## Tools

| Tool | Purpose |
|---|---|
| `remote_hosts_list` | Hosts, phases, and remote facts |
| `remote_host_add` | Register an SSH target and start discovery |
| `remote_host_connect` | Connect/reconnect/refresh |
| `remote_workspaces_list` | Workspaces on a connected host |
| `remote_sessions_list` | Sessions, optionally one workspace |
| `remote_session_snapshot` | Newest page of a remote session's event log |
| `remote_web_url` | Authenticated remote DSH URL through the tunnel |

## Configuration

See [`cordis.patch.yml`](cordis.patch.yml) and
[`examples/local-plugin.patch.yml`](../../examples/local-plugin.patch.yml).

## Security

The token is stored locally and never returned to the browser. The browser calls the host through
DSH's authenticated `/api` Fetch route, not through a custom unauthenticated route. See the
[root README](../../README.md#security-model).
