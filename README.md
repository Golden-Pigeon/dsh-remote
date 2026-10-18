# dsh-remote

Remote development that behaves like a local session.

Add an SSH host once. The plugin provisions the remote DSH runtime itself, mirrors its workspaces and
sessions into the local sidebar, and opens a remote session in the **ordinary Conversation UI** — the
same transcript, composer, tool cards, stop control, and session list as a local session.

![Remote session in the native conversation UI](docs/images/remote-development-native.png)

```text
Local DSH                                         Remote host
┌──────────────────────────────────────┐          ┌──────────────────────────────┐
│ normal sidebar + Conversation UI     │          │ dsh web (installed by plugin)│
│  local mirror Session + Agent façade │  SSH     │ dsh-remote-agent             │
│  host registry / auto provisioning   │◀────────▶│  workspace/session write     │
│  local credential proxy  ◀──reverse──┼──────────│  remote tools + model calls  │
│  authenticated /api route            │  tunnel  │                              │
└──────────────────────────────────────┘          └──────────────────────────────┘
```

## What works now

| Capability | State |
|---|---|
| One-click local plugin install (`scripts/install-local.sh`) | Available |
| Plugin-owned remote provisioning over SSH | Available |
| Host registry, discovery, SSH tunnel, health, reconnect | Available |
| Remote workspaces appear as normal local workspaces | Available |
| Remote sessions appear in the normal sidebar | Available |
| Remote sessions open in the normal Conversation UI | Available |
| Prompts, stop, transcripts, tool cards, usage | Available |
| Local model key proxy through a reverse SSH tunnel | Available |
| Full remote DSH UI through the tunnel (`开始使用`) | Available |
| Agent tools for host/workspace/session operations | Available |
| Approval prompts bridged into the local UI | Not yet — use the full remote UI |
| Relay/NAT traversal, cloud sandbox, multi-tenant | Not yet |

## Install

Quit DSH Desktop completely (including the tray process), then:

```sh
cd /path/to/dsh-remote/dsh-remote
./scripts/install-local.sh
```

The script builds the workspace, packs the plugin with the bundled remote agent, and installs it into
the `desktop` profile. For a DSH Web profile:

```sh
./scripts/install-local.sh --profile web
# restart that DSH Web process
```

Reopen DSH. **Settings → 远程开发** appears.

## Use

1. In **Settings → 远程开发**, enter the SSH target (`example-host`) and click **保存并连接**.
2. On first use the plugin discovers or installs the remote agent, starts remote `dsh web`, opens the
   loopback tunnel, and starts the local credential proxy. The card shows **安装中 → 已连接**.
3. Click **工作区**, add an existing remote directory (for example `/tmp`), and click **添加工作区**.
   The remote workspace appears in the normal left sidebar as `Native Example host · tmp`.
4. Click **+ 新会话** (in Settings or the normal workspace row). The plugin creates the remote
   session, creates a local mirror, and **opens it in the ordinary Conversation UI**. The workspace
   row's **New session** action uses the same remote path.
5. Type in the usual composer. The remote DSH runs the turn; the local transcript updates live. Tool
   calls, usage, stop, and multi-turn follow-ups behave like a local session.
6. **开始使用** on the host card opens the complete remote DSH UI when you need the remote file tree,
   terminal, diffs, or approval dialogs.

The Settings page is now only host/workspace management. The conversation is not a popup.

## How the native session works

The plugin does not embed a second chat UI and does not iframe the remote page. It:

1. creates a real local `Session` seeded from the remote session's committed event log;
2. registers a small custom Agent façade for that local session;
3. routes `followup`/`steer`/`cancel` from the local Agent façade to the remote agent API;
4. follows the remote log and appends new committed events to the local Session;
5. lets DSH's existing Session Controller, sidebar, Conversation assembler, composer, and tool renderers
   display it exactly like a local session.

The remote DSH remains the execution owner. The local Session is a durable, live mirror, so the
ordinary client code paths handle rendering, selection, streaming, and the transcript.

## Model credentials

The model API key stays on the local machine:

- local plugin resolves `DEEPSEEK_API_KEY` from the local DSH credential store;
- remote DSH starts with `DEEPSEEK_BASE_URL=http://127.0.0.1:47821` and a placeholder key;
- the SSH tunnel adds `-R 127.0.0.1:47821:127.0.0.1:<local-proxy-port>`;
- the local proxy injects the real key and forwards to `credentialProxyUpstream`.

If no local key is resolved, the plugin still provisions and connects; configure credentials in the
remote DSH UI or use `credentialProxy: false`. The host card shows **模型代理：本地代理 / 远端**.

## Agent tools

| Tool | Purpose |
|---|---|
| `remote_hosts_list` | Hosts, phases, remote facts |
| `remote_host_add` | Add an SSH host and start provisioning |
| `remote_host_connect` | Connect/reconnect/refresh |
| `remote_host_provision` | Force reinstall/restart and reconnect |
| `remote_workspace_add` | Register a remote directory |
| `remote_workspaces_list` | List remote workspaces |
| `remote_session_create` | Create a remote session |
| `remote_sessions_list` | List remote sessions |
| `remote_session_prompt` | Send a prompt |
| `remote_session_snapshot` | Read a transcript page |
| `remote_session_cancel` | Cancel the active turn |
| `remote_web_url` | Authenticated full remote UI URL |

## Requirements

**Local:** DSH Desktop/Web, `ssh` with key or ssh-agent auth.

**Remote:** Linux or macOS, Node.js 22.19+, npm, SSH server. The installer discovers nvm, Volta, fnm,
and Bun. Windows remotes are not supported.

## Security

- SSH is the transport; tunnels bind `127.0.0.1` only.
- Host keys default to TOFU (`accept-new`); use `yes` with a prepared `known_hosts` for strict checks.
- The remote agent is loopback-only and bearer-authenticated. Its write surface is limited to
  workspace/session create, prompt, and cancel. Prompts can make the remote DSH use its own tools under
  the remote sandbox and approval policy.
- The real model key never reaches the remote host; only the local proxy has it.
- Browser requests use DSH Connection's authenticated `/api` Fetch route. Tokens/credentials are stored
  in `0600` files and never returned to the browser.
- Only connect trusted remote accounts; the remote DSH has that account's privileges.

## Configuration

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

    # Mirror remote work into the ordinary local UI.
    mirrorSessions: true
    mirrorPollMs: 1500
    mirrorMaxEvents: 2000
```

The remote agent config remains available for advanced deployments:

```yaml
- id: dsh-remote-agent
  config:
    stateFile: ''
    token: ''
    loopbackOnly: true
    defaultSnapshotEvents: 500
    maxSnapshotEvents: 2000
    heartbeatMs: 15000
```

## Known limits

- Approval prompts are not bridged into the local mirror yet. Tools that require approval may block;
  open **开始使用** to answer them in the full remote UI.
- The local workspace anchor is a metadata handle; the remote file tree/terminal is in the full remote
  UI. Conversation, prompts, stop, tool cards, and usage are native.
- A remote session longer than `mirrorMaxEvents` is not mirrored; open it in the full remote UI.
- Windows remotes and relay/NAT traversal are not supported.

## Troubleshooting

| Symptom | Action |
|---|---|
| **安装中** never finishes | Check `ssh -o BatchMode=yes example-host true`; fix SSH and click **重新安装** |
| `does not accept POST` | Remote agent is old; click **重新安装** |
| No remote workspace in sidebar | Click **工作区** and add one; wait for the sync message |
| Native session has no reply | Check **模型代理**; configure remote credentials or use full UI |
| Approval blocked | Open the full remote UI with **开始使用** |
| Remote UI asks for login | Click **开始使用** again for a new launch URL |
| Port changed after remote restart | Click **重新发现** |

Remote logs: `journalctl --user -u dsh-remote-agent -f` or `$DSH_HOME/remote-agent/web.log`.

## Verify

```sh
pnpm verify
```

The suite covers protocol/SSE/cursor/write contracts, installer rendering, proxy forwarding, and the
client bundle. The native path was validated against a real Linux example-host host: plugin provisioning,
remote workspace/session creation, a remote prompt through the local key proxy, live event mirroring
into the ordinary Conversation UI, a second follow-up, and a remote tool call/result.

The full remote UI remains available for comparison and approval-heavy work.

## Documentation

- [Wire protocol](docs/protocol.md)
- [Operations guide](docs/operations.md)
- [ADR-001](docs/decisions/ADR-001-protocol-envelope.md)
- [Design document copy](docs/remote-development-design.md)

## Packages

| Package | Role |
|---|---|
| [`@dsh-remote/protocol`](packages/protocol) | Wire types, surface metadata, cursor, SSE, typed client |
| [`dsh-remote-local-plugin`](packages/local-plugin) | Provisioning, tunnel, proxy, **native session mirror**, tools, Settings |
| [`dsh-remote-agent`](packages/remote-agent) | Remote host plugin for workspaces, sessions, prompts, SSE |
| [`@dsh-remote/installer`](packages/installer) | Bootstrap library/CLI used by the plugin |
| [`@dsh-remote/testkit`](packages/testkit) | Fake host and wire contract tests |

## License

MIT. See [LICENSE](LICENSE).
