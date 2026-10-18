# dsh-remote

Remote development for DeepSeek Harness, usable from one Settings page:

- add an SSH host;
- the plugin installs and starts the remote DSH + agent **by itself**;
- add a remote project directory;
- create a remote session, send prompts, and read responses in the local UI;
- or open the full remote DSH UI through the same tunnel.

No separate remote install commands. The model API key stays on the local machine: model traffic is
forwarded through an SSH reverse tunnel to a loopback credential proxy.

```text
Local DSH                                         Remote host
┌──────────────────────────────────────┐          ┌──────────────────────────────┐
│ Settings → 远程开发                  │          │ dsh web (installed by plugin)│
│  host registry / auto provisioning   │  SSH     │ dsh-remote-agent             │
│  remote chat drawer / tools          │◀────────▶│  workspace.create            │
│  local credential proxy  ◀──reverse──┼──────────│  session.create/prompt/cancel│
│  authenticated /api route            │  tunnel  │  session snapshot + SSE      │
└──────────────────────────────────────┘          └──────────────────────────────┘
```

![Remote development chat](docs/images/remote-development-chat.png)

## What works now

| Capability | State |
|---|---|
| One-click local plugin install (`scripts/install-local.sh`) | Available |
| Plugin-owned remote provisioning over SSH | Available |
| Host registry, discovery, SSH tunnel, health, reconnect | Available |
| Add/remove remote workspace directories from the local UI | Available |
| Create remote sessions from the local UI | Available |
| Send prompts, cancel turns, read the transcript locally | Available |
| Local model key proxy through a reverse SSH tunnel | Available |
| Full remote DSH UI through the tunnel (`开始使用`) | Available |
| Agent tools for all of the above | Available |
| Remote session rendered in the local main conversation area | Not yet |
| Relay/NAT traversal, cloud sandbox, multi-tenant | Not yet |

## Install (local plugin)

Quit DSH Desktop completely first (including the tray process), then:

```sh
cd /path/to/dsh-remote/dsh-remote
./scripts/install-local.sh
```

The script builds the workspace, packs the plugin with the bundled remote agent, and installs it into
the `desktop` profile. For a DSH Web profile:

```sh
./scripts/install-local.sh --profile web
# then restart that DSH Web process
```

Reopen DSH. **Settings → 远程开发** appears.

## Use

1. Enter the SSH target, for example `example-host`, and click **保存并连接**.
2. On first use the plugin:
   - discovers the remote agent over SSH;
   - uploads its bundled `dsh-remote-agent` tarball;
   - installs Node dependencies/pnpm/DSH on the remote host when missing;
   - starts `dsh web` on `127.0.0.1`;
   - opens a loopback SSH tunnel and connects.
   The host card shows **安装中** with progress, then **已连接**.
3. Click **工作区**, enter an existing remote directory (for example `/home/me/project`), and click
   **添加工作区**.
4. Click **+ 新会话**, type a prompt, and press **发送**. The remote DSH agent runs the turn; the local
   drawer polls the committed transcript and shows the result.
5. Click **开始使用** for the complete remote DSH UI (terminal, files, diffs, approvals, tools).

The local model key is resolved from the local DSH credential store at connect time. The remote DSH
is configured with a placeholder key and a loopback base URL; a reverse SSH forward sends its model
requests to the local proxy, which injects the real key. The key never lands in the remote state files,
the remote DSH profile, or the tunnel config.

If the local key is unavailable, the plugin still provisions the remote host; configure credentials
in the remote DSH UI (or via its own environment) and the full remote UI remains usable.

## Agent tools

The same operations are available to the model:

| Tool | Purpose |
|---|---|
| `remote_hosts_list` | Hosts, phases, and remote facts |
| `remote_host_add` | Add an SSH host and start provisioning |
| `remote_host_connect` | Connect/reconnect/refresh |
| `remote_host_provision` | Force reinstall/restart and reconnect |
| `remote_workspace_add` | Register a remote directory as a workspace |
| `remote_workspaces_list` | List workspaces |
| `remote_session_create` | Create a remote session |
| `remote_sessions_list` | List remote sessions |
| `remote_session_prompt` | Send a prompt to a remote session |
| `remote_session_snapshot` | Read the committed transcript page |
| `remote_session_cancel` | Cancel the active turn |
| `remote_web_url` | Authenticated full remote UI URL |

Example:

> 把 example-host 添加为远程主机，在 `/home/me/project` 建一个工作区，然后开个会话总结这个项目的结构。

## Requirements

**Local:** DSH Desktop/Web with the `desktop` or `web` profile, `ssh` with key/ssh-agent auth.

**Remote:** Linux or macOS, Node.js 22.19+, npm, SSH server. The installer can discover nvm, Volta,
fnm, and Bun installations. Windows remotes are not supported yet.

## Security model

- SSH is the transport; the tunnel binds `127.0.0.1` only and uses `-N`.
- Host keys default to TOFU (`accept-new`); set `yes` for a pre-populated `known_hosts`.
- The remote agent is loopback-only and bearer-authenticated. It now has a small **write surface**
  (workspace create, session create/prompt/cancel) in addition to read projections. It does not
  execute arbitrary shell commands or expose file contents.
- The model key is injected by the **local** credential proxy. The remote DSH gets only a placeholder
  key. The reverse proxy is reachable on the remote loopback interface while the tunnel is up; only
  connect trusted hosts.
- The browser talks to the local host through DSH Connection's authenticated `/api` Fetch route.
- Remote tokens and local credentials are stored in `0600` files and never returned to the browser.

## Configuration

The default works for most setups. Override in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-remote-local
  config:
    autoProvision: true
    remoteDshHome: ~/.dsh
    remoteInstallDir: ~/.local/share/dsh-remote
    remoteDshVersion: 0.2.1-rc.2
    remoteStart: systemd          # systemd | nohup | none
    credentialProxy: true
    credentialProxyUpstream: https://api.deepseek.com
    credentialProxyRemotePort: 47821
    modelCredentialRef: DEEPSEEK_API_KEY
```

The remote agent config remains available for advanced deployments:

```yaml
- id: dsh-remote-agent
  config:
    stateFile: ''                 # $DSH_HOME/remote-agent/agent.json
    token: ''                     # reuse or mint
    loopbackOnly: true
    defaultSnapshotEvents: 500
    maxSnapshotEvents: 2000
    heartbeatMs: 15000
```

## Troubleshooting

| Symptom | Action |
|---|---|
| **安装中** never finishes | Check `ssh -o BatchMode=yes example-host true`; inspect the host card error. Click **重新安装** after fixing SSH. |
| `remote agent: ... does not accept POST` | The remote agent is old. Click **重新安装** to update it. |
| `已连接` but no model reply | The local credential proxy may have no key; configure remote credentials or check the full remote UI. |
| Add workspace fails | The directory must already exist on the remote host; pass an absolute path. |
| Remote UI asks for login | Click **开始使用** again for a fresh launch URL. |
| Port changed after a remote restart | Click **重新发现**; the plugin re-reads the state file and reconnects. |

Remote logs: `journalctl --user -u dsh-remote-agent -f` for systemd, or
`$DSH_HOME/remote-agent/web.log` for nohup.

## Packages

| Package | Role |
|---|---|
| [`@dsh-remote/protocol`](packages/protocol) | Wire types, versioning, errors, cursor, SSE, typed client (reads and writes) |
| [`dsh-remote-local-plugin`](packages/local-plugin) | Host registry, plugin-owned provisioning, proxy, authenticated API, tools, Settings page, remote chat |
| [`dsh-remote-agent`](packages/remote-agent) | Remote host plugin: workspaces, sessions, prompts, SSE, full remote UI URL |
| [`@dsh-remote/installer`](packages/installer) | Bootstrap library/CLI used by the plugin and for debugging |
| [`@dsh-remote/testkit`](packages/testkit) | Fake remote host and contract tests, including write flows |

## Verify

```sh
pnpm verify
```

The contract tests cover health, workspace/session listing, snapshots, SSE replay, live appends,
workspace create, session create, prompt, cancel, auth failures, and protocol mismatch.

The end-to-end path was validated against a real Linux example-host host:
plugin → SSH → automatic remote install → workspace create → session create → prompt → reverse-tunnel
credential proxy → model response → local transcript. The full remote UI also opens through the same
tunnel.

## Documentation

- [Wire protocol](docs/protocol.md)
- [Operations guide](docs/operations.md)
- [ADR-001: envelope vs `/api/remote.mux`](docs/decisions/ADR-001-protocol-envelope.md)
- [Design document copy](docs/remote-development-design.md)

## License

MIT. See [LICENSE](LICENSE).
