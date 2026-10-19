# dsh-remote

[![CI](https://github.com/Golden-Pigeon/dsh-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/Golden-Pigeon/dsh-remote/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-remote-local-plugin.svg)](https://www.npmjs.com/package/dsh-remote-local-plugin)

English | [Chinese](README.zh.md)

Remote development that behaves like a local session.

Add an SSH host once. The plugin provisions the remote DSH runtime itself, mirrors its workspaces and
sessions into the local sidebar, and opens a remote session in the **ordinary Conversation UI** — the
same transcript, composer, tool cards, stop control, and session list as a local session.

```text
Local DSH                                         Remote host
┌──────────────────────────────────────┐          ┌──────────────────────────────┐
│ normal sidebar + Conversation UI     │          │ dsh web (installed by plugin)│
│  local mirror Session + Agent façade │  SSH     │ dsh-remote-agent             │
│  host registry / auto provisioning   │◀────────▶│  workspace/session write     │
│  direct key or local key proxy        │          │  remote tools + model calls  │
│  authenticated /api route            │  tunnel  │                              │
└──────────────────────────────────────┘          └──────────────────────────────┘
```

## Supported environment

This plugin is developed for the **official DSH Desktop application**. The only tested and supported
DSH version is:

| Component | Tested version |
|---|---|
| [DSH Desktop / official client](https://github.com/deepseek-ai/deepseek-harness) | [**0.2.1-rc.2**](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2) |
| Plugin | [**0.8.5**](https://www.npmjs.com/package/dsh-remote-local-plugin) |
| Remote DSH runtime | [**0.2.1-rc.2**](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2) |
| Remote Node.js | [**22.19+**](https://nodejs.org/en/download) |
| Remote OS | Linux or macOS |

Other DSH GUI plugins, community forks, modified clients, non-DSH GUIs, and other DSH versions have
**not** been tested. The package's dependency range is intentionally permissive for installation, but
it is not a compatibility or support guarantee. Pin DSH to [`0.2.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2) when using this release.

## What works now

| Capability | State |
|---|---|
| One-click local plugin install (`scripts/install-local.sh`) | Available |
| Plugin-owned remote provisioning over SSH | Available |
| Host registry, discovery, SSH tunnel, health, reconnect | Available |
| Remote workspaces appear as normal local workspaces | Available |
| Remote sessions appear in the normal sidebar | Available |
| Remote sessions open in the normal Conversation UI | Available |
| Localized UI follows the DSH language (zh / en) | Available |
| Prompts, stop, transcripts, tool cards, usage | Available |
| Direct remote key (default) or optional local key proxy | Available |
| Remote file tree and file previews | Available (SSH-backed) |
| Remote terminal per Session | Available (local Sessions keep local PTY; remote Sessions use SSH PTY) |
| Agent tools for host/workspace/session operations | Available |
| Approval prompts bridged into the local UI | Available |
| Relay/NAT traversal, cloud sandbox, multi-tenant | Not yet |

## Install

### From the DSH plugin page

Open **Plugins → Add plugin** and enter:

```text
dsh-remote-local-plugin
```

The package is published on [npm](https://www.npmjs.com/package/dsh-remote-local-plugin); DSH installs the bundle from the registry. The package includes the remote agent asset and the
terminal-controller fork, so there is nothing else to install. Restart DSH when the plugin page asks
for it; **Settings → Remote development** then appears.

### From a source checkout

For development, clone the repository and run the installer:

```sh
cd /path/to/dsh-remote/dsh-remote
pnpm install
pnpm -r build
./scripts/install-local.sh
```

The script builds the workspace, creates a single plugin tarball containing the terminal-controller
fork, and installs that tarball into the `desktop` profile. For a DSH Web profile:

```sh
./scripts/install-local.sh --profile web
# restart that DSH Web process
```

Reopen DSH. **Settings → Remote development** appears.

## Use

1. In **Settings → Remote development**, enter the SSH target (`my-host`) and click **Save and connect**.
2. On first use the plugin discovers or installs the remote agent, starts remote `dsh web`, opens the
   loopback tunnel, and copies the resolved model key into the remote environment. The card shows
   **Installing → Connected** and **Model credentials: Remote direct**.
3. In the sidebar **Workspaces** header, click **+**. The create dialog chooses **This computer** or a
   connected **Remote device**, then **Add** a source folder. Local folders use the native system
   directory picker; remote folders use the read-only SSH browser.
4. The create flow opens a remote Session, creates a local mirror, and **opens it in the ordinary
   Conversation UI**. The workspace row's **New session** action uses the same remote path.
5. Type in the usual composer. The remote DSH runs the turn; the local transcript updates live. Tool
   calls, usage, stop, and multi-turn follow-ups behave like a local session.
6. The **Workspace files** and **New terminal** panels follow the selected Session: local Sessions
   use the local machine, remote mirror Sessions use the remote workspace.

The Settings page is now only host/workspace management. The conversation is not a popup.

## Test/CI workspace visibility

Test isolation is controlled by a test-only manifest in the test DSH home, not by the Settings UI or
an agent tool:

```text
$DSH_HOME/remote/test-visibility.json
```

```json
{"hiddenPaths": ["/tmp/dsh-remote-tests"], "hiddenWorkspaceIds": ["remote-workspace-id"]}
```

`hiddenPaths` prevents local registration at creation. `hiddenWorkspaceIds` hides an existing visible
test workspace after the run; local mirror sessions are archived, not deleted, and are restored when
the entry is removed. See [docs/testing.md](docs/testing.md).

## Development and testing

Agent-facing testing instructions live in [AGENTS.md](AGENTS.md). For UI/integration work use the
isolated environment:

```sh
./scripts/test-sandbox.sh
```

See [docs/testing.md](docs/testing.md) for test workspace visibility.

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

**Default: direct key on the remote host.** The plugin resolves `DEEPSEEK_API_KEY` from the local DSH
credential store and writes it into the remote `dsh web` environment, with
`DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic`. The remote agent calls DeepSeek directly.

**Optional: local proxy.** Set `credentialProxy: true` to keep the key local:

- remote DSH gets `DEEPSEEK_BASE_URL=http://127.0.0.1:47821` and a placeholder key;
- the SSH tunnel adds `-R 127.0.0.1:47821:127.0.0.1:<local-proxy-port>`;
- the local proxy injects the real key and forwards to `credentialProxyUpstream`.

If no local key resolves, the plugin still provisions and connects; configure the remote DSH's own
credentials. The host card shows **Model credentials: Local proxy / Remote direct / Remote default**.

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

## Requirements

**Local:** official [DSH Desktop](https://github.com/deepseek-ai/deepseek-harness) or DSH Web with the same core version, plus `ssh` with key or ssh-agent auth. Only the official Desktop client is a verified GUI target.

**Remote:** Linux or macOS with an SSH server. [Node.js 22.19+](https://nodejs.org/en/download) is preferred and discovered through
PATH, nvm, Volta, fnm, Bun, asdf, mise, Nix, Homebrew, and the login shell. When no usable Node.js is
found, the installer downloads the official [Node.js tarball](https://nodejs.org/en/download) into `remoteInstallDir`, verifies its
SHA-256 checksum, and uses it without root. This needs `curl` or `wget`, `tar`, and `sha256sum` or
`shasum`; Windows remotes are not supported.

If the remote host needs a proxy, set `remoteInstallProxy` to a URL that is reachable **from the
remote host**, for example `http://127.0.0.1:17890` when a port forward serves the proxy there. The
installer exports `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `npm_config_*` for the bootstrap.
When the option is empty, it uses the account's actual login shell (bash, zsh, fish, and other common shells) and its login/interactive startup files to read `HTTPS_PROXY`/`HTTP_PROXY`.
The same proxy is written into the remote systemd unit (or inherited by the `nohup` process), so
remote model requests use it as well, not just the installer.

## Security

- SSH is the transport; tunnels bind `127.0.0.1` only.
- Host keys default to TOFU (`accept-new`); use `yes` with a prepared `known_hosts` for strict checks.
- The remote agent is loopback-only and bearer-authenticated. Its write surface is limited to
  workspace/session create, prompt, and cancel. Prompts can make the remote DSH use its own tools under
  the remote sandbox and approval policy.
- In the default direct mode, the resolved model key is written to the remote systemd/nohup
  environment. Use this only on a trusted remote account; the systemd unit is written with mode 0600.
  Set `credentialProxy: true` to keep the key local and proxy model traffic through the reverse SSH
  tunnel. Proxy requests require a per-host token, so unrelated local users on the remote host cannot
  reuse the tunneled credential endpoint.
- Browser requests use DSH Connection's authenticated `/api` Fetch route. Tokens/credentials are stored
  in `0600` files and never returned to the browser.
- File-tree, preview, and terminal traffic also stays inside the authenticated SSH tunnel.
- Only connect trusted remote accounts; the remote DSH has that account's privileges.

## Configuration

```yaml
- id: dsh-remote-local
  config:
    autoProvision: true
    remoteDshHome: ~/.dsh
    remoteInstallDir: ~/.local/share/dsh-remote
    remoteDshVersion: 0.2.1-rc.2
    remotePnpmVersion: 11.21.0
    remoteNodeVersion: 22.19.0
    # Remote-visible proxy for Node/npm/DSH downloads. Empty means inspect the remote login shell.
    remoteInstallProxy: ''
    remoteInstallNoProxy: 127.0.0.1,localhost
    autoInstallNode: true
    remoteStart: systemd          # systemd | nohup | none
    # Direct key mode (default): copy the resolved key to the remote service env.
    credentialProxy: false
    copyModelKey: true
    remoteModelBaseUrl: https://api.deepseek.com/anthropic

    # Optional proxy mode: keep the key local.
    credentialProxyUpstream: https://api.deepseek.com/anthropic
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

- The complete remote DSH browser UI is not offered by default. The remote host disables its
  Remote-Event carrier so approval waterfalls reach the native local UI; this is the tradeoff that
  makes **Allow once / Reject** work in the ordinary conversation.
- The local workspace anchor is a metadata handle. File listing, preview, and terminal are routed to
  the remote workspace; remote diffs and some advanced file actions still use the native session's
  own tool results.
- A remote session longer than `mirrorMaxEvents` is not mirrored; increase the limit or open it on the
  remote host directly.
- Windows remotes and relay/NAT traversal are not supported.

## Troubleshooting

| Symptom | Action |
|---|---|
| **Installing** never finishes / `Waiting for remote dsh web…` | Check `ssh -o BatchMode=yes my-host true`; the installer discovers nvm/Volta/fnm and automatically downloads Node.js when needed. If the host blocks nodejs.org or checksum tools, install [Node.js 22.19+](https://nodejs.org/en/download) manually or use `remoteStart: nohup`; then **Reinstall** |
| `does not accept POST` | Remote agent is old; click **Reinstall** |
| No remote workspace in sidebar | Use **Workspaces +**, or Settings → Remote development → Workspaces |
| Native session has no reply | Check **Model credentials**; configure remote credentials |
| `DeepSeek Messages request failed (404)` | Proxy upstream must be `https://api.deepseek.com/anthropic`; the fixed proxy joins/preserves the provider prefix. Reinstall the local plugin and reconnect |
| Approval appears locally but remote tool still fails | The local decision was sent; check the remote tool result |
| Local terminal opens local shell | Expected for local Sessions; remote Sessions use `Remote · <dir>` terminals |
| Remote terminal opens local zsh | The terminal-controller fork is not active; run `./scripts/install-local.sh` again |
| Port changed after remote restart | Click **Rediscover** |

Remote logs: `journalctl --user -u dsh-remote-agent -f` or `$DSH_HOME/remote-agent/web.log`.

## Verify

```sh
pnpm verify
```

The suite covers protocol/SSE/cursor/write contracts, installer rendering, proxy forwarding, and the
client bundle. The native path was validated against a real Linux remote host: plugin provisioning,
remote workspace/session creation, a remote prompt through the local key proxy, live event mirroring
into the ordinary Conversation UI, a second follow-up, and a remote tool call/result.

## Documentation

- [Wire protocol](docs/protocol.md)
- [Operations guide](docs/operations.md)
- [Testing](docs/testing.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [ADR-001](docs/decisions/ADR-001-protocol-envelope.md)
- [Design document copy](docs/remote-development-design.md)

## Packages

| Package | Role |
|---|---|
| [`@dsh-remote/protocol`](packages/protocol) | Wire types, surface metadata, cursor, SSE, typed client |
| [`dsh-remote-local-plugin`](packages/local-plugin) | Provisioning, tunnel, proxy, **native session mirror**, tools, Settings |
| [`dsh-remote-agent`](packages/remote-agent) | Remote host plugin for workspaces, sessions, prompts, SSE |
| [`dsh-remote-terminal-controller`](packages/terminal-controller) | Profile fork routing local vs mirrored terminals |
| [`@dsh-remote/installer`](packages/installer) | Bootstrap library/CLI used by the plugin |
| [`@dsh-remote/testkit`](packages/testkit) | Fake host and wire contract tests |

## License

MIT. See [LICENSE](LICENSE).
