# dsh-remote

Remote development for DeepSeek Harness: manage SSH hosts, discover a remote DSH runtime, list its
workspaces and sessions, and open the remote UI through a loopback tunnel — all from a DSH Settings
page or an agent tool.

This repository implements the Phase 0/1 scope from the design document:

```text
Local DSH (desktop/web)                         Remote host
┌──────────────────────────┐                    ┌──────────────────────────┐
│ dsh-remote-local-plugin  │  SSH tunnel        │ dsh-remote-agent         │
│  host registry           │◀──────────────────▶│  /dsh-remote-agent/api/v1│
│  discovery + tunnel      │  bearer token      │  health/workspaces       │
│  Connection Fetch route  │                    │  sessions + SSE events   │
│  Settings page + tools   │                    │  read-only projections   │
└──────────────────────────┘                    └──────────────────────────┘
```

## Status

| Capability | State |
|---|---|
| Host registry, SSH discovery, token handling | Implemented |
| Loopback SSH tunnel with health + reconnect | Implemented |
| Remote workspace and session discovery | Implemented |
| Remote session snapshot + live SSE follow | Implemented (protocol/agent) |
| Authenticated local UI bridge | Implemented via Connection `/api` Fetch route |
| Settings page: add/connect/remove host, workspace/session browse | Implemented |
| Model tools: list/add/connect/workspaces/sessions/snapshot/web URL | Implemented |
| Remote agent installer (systemd/nohup) | Implemented |
| Fake host + wire contract tests | Implemented |
| B-native remote session in the local main area | Phase 2 (`dsh-remote-client`) |
| Credential proxy that keeps API keys local | Phase 2 |
| Relay / NAT traversal / cloud sandbox | Not started |

**Important:** the local plugin currently provides the **A** model (local session + remote execution
surface) plus a **B-lite** window into the remote DSH UI. It does not yet attach a remote session into
the local main conversation area without an iframe. That is the Phase 2 work tracked in the companion
repository.

## Packages

| Package | Role |
|---|---|
| [`@dsh-remote/protocol`](packages/protocol) | Version negotiation, wire types, envelopes, errors, cursor rules, SSE parser, typed HTTP client |
| [`dsh-remote-local-plugin`](packages/local-plugin) | Host registry, SSH discovery/tunnel, health/reconnect, model tools, authenticated host API, Settings page |
| [`dsh-remote-agent`](packages/remote-agent) | Remote DSH plugin: loopback-only bearer API for host, workspaces, sessions, and SSE events |
| [`@dsh-remote/installer`](packages/installer) | `dsh-remote-install` CLI: pack, upload, install Node/pnpm/DSH, add the agent, start `dsh web` |
| [`@dsh-remote/testkit`](packages/testkit) | In-memory fake remote host and contract tests |

The companion [`dsh-remote-client`](../dsh-remote-client) repository contains the host-aware client
seams and the pinned-upstream patch workflow.

## Quick start

### 1. Build

```sh
pnpm install
pnpm verify
```

### 2. Install the remote agent

The remote host needs Node.js 22.19+ and npm. The installer finds nvm/Volta/fnm/Bun installations,
installs pnpm and the pinned DSH locally when missing, adds the agent to the chosen profile, and
starts `dsh web` on `127.0.0.1`.

```sh
node packages/installer/lib/cli.js install --target user@host
# or inspect the generated script first:
node packages/installer/lib/cli.js plan --target user@host
```

The model API key is **not** copied. Configure the remote DSH or use your own key on that machine
until the Phase 2 credential proxy exists.

### 3. Install the local plugin

Quit DSH Desktop completely, then install the packed plugin into the desktop profile:

```sh
cd packages/local-plugin
npm pack
# Use the DSH CLI that belongs to your installation:
dsh plugin --profile desktop add ./dsh-remote-local-plugin-0.1.0.tgz
```

Reopen DSH, open **Settings → 远程开发**, add `user@host`, and connect. The host card lists the remote
workspaces; expanding a workspace lists its sessions. **打开远端界面** opens the authenticated remote
DSH UI through the tunnel.

If the remote `DSH_HOME` is not `~/.dsh`, set `remoteStateFile` in the plugin config to the absolute
state path, for example `/srv/dsh/remote-agent/agent.json`.

### 4. Optional: drive it from the agent

The same operations are available as tools: `remote_hosts_list`, `remote_host_add`,
`remote_host_connect`, `remote_workspaces_list`, `remote_sessions_list`,
`remote_session_snapshot`, `remote_web_url`.

## Security model

- SSH is the transport. The tunnel binds `127.0.0.1` only and uses `-N` (no remote shell at runtime).
- SSH key or ssh-agent authentication is required for non-interactive tunnels. Host keys default to
  TOFU (`StrictHostKeyChecking=accept-new`); set `yes` for a pre-populated `known_hosts`.
- The remote agent is a **read-only** API. It does not execute tools, mutate sessions, or expose
  files. It binds behind the remote DSH loopback listener and additionally enforces loopback peers.
- The agent token is generated on first start, stored in a `0600` state file, and sent as a bearer
  token. The local plugin stores it in a `0600` `hosts.json` and never returns it to the browser.
- The browser bridge uses DSH Connection's authenticated `/api` Fetch route. There is no separate
  unauthenticated UI route.
- The remote process still has the remote user's shell privileges. This is not a sandbox or a
  container boundary.
- Model API keys are not copied to the remote host by the installer.

## Configuration

Local plugin (`cordis.patch.yml`):

```yaml
- id: dsh-remote-local
  config:
    stateDir: ~/.dsh/remote
    remoteStateFile: ~/.dsh/remote-agent/agent.json
    sshBinary: ssh
    probeTimeoutMs: 10000
    connectTimeoutMs: 15000
    healthIntervalMs: 15000
    reconnect: true
    maxReconnectDelayMs: 30000
    strictHostKeyChecking: accept-new
```

Remote agent (`cordis.patch.yml`):

```yaml
- id: dsh-remote-agent
  config:
    stateFile: ''          # $DSH_HOME/remote-agent/agent.json
    token: ''              # reuse or mint
    loopbackOnly: true
    defaultSnapshotEvents: 500
    maxSnapshotEvents: 2000
    heartbeatMs: 15000
```

## Testing

```sh
pnpm verify                     # build + unit/contract tests
pnpm --filter @dsh-remote/testkit test
node --import tsx packages/local-plugin/test/... # focused tests
```

The wire contract test starts an in-memory fake host and exercises health, workspace/session
listing, snapshots, SSE replay, appended live events, auth failure, and protocol mismatch.

The implementation was also validated against a real Linux example-host host: installer bootstrap, remote
agent discovery, SSH tunnel health, workspace/session listing, snapshot, SSE follow, and the Settings
page end-to-end. Test artifacts and tokens are not part of this repository.

## Documentation

- [Wire protocol](docs/protocol.md)
- [Operations guide](docs/operations.md)
- [ADR-001: new envelope vs `/api/remote.mux`](docs/decisions/ADR-001-protocol-envelope.md)
- [Design document copy](docs/remote-development-design.md)

## License

MIT. See [LICENSE](LICENSE).
