# Operations guide

The normal path is: install the local plugin once, add an SSH host, and use the resulting remote
workspace/session in the ordinary DSH sidebar and Conversation UI. The plugin provisions the remote
side itself.

## 1. Install the local plugin

Run the installer; it can install while DSH Desktop is open. Restart the app afterwards to load the new
host and client bundles:

```sh
cd /path/to/dsh-remote/dsh-remote
./scripts/install-local.sh
```

For a DSH Web profile:

```sh
./scripts/install-local.sh --profile web
# restart the DSH Web process after the script finishes
```

The script installs dependencies, builds all packages, packs the remote agent into the local plugin,
packs the terminal-controller fork, and adds both to the chosen profile. The desktop app may stay
running during installation; restart it afterwards to load the new bundles.

## 2. Add a host

Open **Settings → 远程开发**, enter an SSH target (`user@host`, `host:port`, `ssh://…`, or an SSH
config alias), and click **保存并连接**.

The plugin:

1. reads `<remoteDshHome>/remote-agent/agent.json` over SSH;
2. if no agent is present and `autoProvision` is true, uploads its bundled agent, installs pnpm/DSH
   when missing, adds the agent to the remote `web` profile, and starts `dsh web` on `127.0.0.1`;
3. waits for the state file and opens the loopback tunnel;
4. starts the local credential proxy and adds the reverse SSH forward when a local key resolves.

The host card shows `安装中 → 正在连接 → 已连接`. If it fails, fix SSH and click **重新安装**.

## 3. Add a remote workspace

Click **Workspaces +** and choose **远程新建工作区…**, then enter an existing absolute remote directory.

The plugin creates a local anchor and a mirror workspace. The remote workspace then appears in the
normal left sidebar, titled `<host label> · <remote title>`. Sessions in that remote workspace are
mirrored automatically.

## 4. Use the ordinary Conversation UI

Click **+ 新会话** in Settings, or the workspace row's **New session** action. Both use this remote path.
The plugin:

1. creates the remote session;
2. creates a local mirror Session and registers the custom Agent façade;
3. opens that local Session through `uiWorkspace.openSession`.

From there, the normal composer and transcript are used. The remote DSH executes the turn and the
local mirror appends its committed events, so tool cards, usage, follow-ups, and stop behave like a
local session. A second prompt on the same session resumes the remote agent and restarts the mirror
poll.

The sidebar **Workspaces** header **+** opens a small chooser:

- the **+** button opens one create dialog;
- the destination switcher offers **本机** and connected **远端设备**;
- **添加** uses the native system picker for **本机** and a read-only SSH folder browser for remote
  directories. The remote browser never writes to the remote host;
- creating a remote workspace creates its first remote Session, waits for the local mirror, and opens
  it; a local workspace is registered through the normal local workspace registry.

The **Workspace files** and **New terminal** panels are Session-scoped:

- local Session: stock local workspace files and local PTY;
- remote mirror Session: SSH-backed remote file listing/preview and an SSH PTY in the remote workspace.

The install script also installs the `dsh-remote-terminal-controller` profile fork. It disables the
stock terminal-controller row and inserts the fork so `ClientTerminals` is constructed with the
Session-routing provider. This is profile-local; `app.asar` is untouched.

The Settings page is for host/workspace management only; the remote conversation is not a drawer or
iframe.

## Test/CI workspace visibility

Test workspaces use `$DSH_HOME/remote/test-visibility.json` (hidden paths/ids), never a Settings
control or agent tool. The manifest is read during mirror sync. See [testing.md](testing.md) for the
two supported flows: hidden-at-creation for backend tests and visible-then-hidden for UI tests.

## Model credentials

Default direct mode:

- local plugin resolves `DEEPSEEK_API_KEY` from the local DSH credential store;
- provisioning writes `DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic` and the real key into the
  remote `dsh web` systemd/nohup environment;
- the remote DSH calls DeepSeek directly; the key is present on the remote host.

Use direct mode on a trusted remote account. It is the default (`credentialProxy: false`,
`copyModelKey: true`).

Optional proxy mode:

- remote DSH starts with `DEEPSEEK_BASE_URL=http://127.0.0.1:47821` and a placeholder key;
- the tunnel adds `-R 127.0.0.1:47821:127.0.0.1:<local-proxy-port>`;
- the local proxy injects the real key and forwards to `credentialProxyUpstream`.

Set `credentialProxy: true` to use it. If no local key resolves, configure remote credentials or copy
a key into the remote environment manually.

## Native mirror rules

- The mirror is a local `Session` seeded from the remote committed event log. The remote session
  remains the execution owner.
- Local prompts are delivered to the remote agent. The optimistic local submission is settled by
  reusing its message identity when the remote `user/message` event arrives, so the transcript does
  not show a duplicate pending message.
- The local `model/selection` event is forwarded with the next prompt; the remote session selects that
  model before prompting.
- The mirror polls the remote log at `mirrorPollMs`, appends only contiguous events, and stops when a
  cold remote session is fully caught up. A new prompt restarts it.
- Remote sessions longer than `mirrorMaxEvents` are skipped with a warning; increase the limit or
  work on the remote host directly.
- On plugin restart, old local mirrors are archived and recreated from the current remote log.

## Configuration

Local plugin profile override:

```yaml
- id: dsh-remote-local
  config:
    stateDir: ''                    # $DSH_HOME/remote
    sshBinary: ssh
    remoteStateFile: ''             # <remoteDshHome>/remote-agent/agent.json
    probeTimeoutMs: 10000
    connectTimeoutMs: 15000
    healthIntervalMs: 15000
    reconnect: true
    maxReconnectDelayMs: 30000
    strictHostKeyChecking: accept-new

    autoProvision: true
    remoteDshHome: ~/.dsh
    remoteInstallDir: ~/.local/share/dsh-remote
    remoteDshVersion: 0.2.1-rc.2
    remotePnpmVersion: 11.21.0
    remoteStart: systemd            # systemd | nohup | none
    provisionTimeoutMs: 600000

    credentialProxy: false
    copyModelKey: true
    remoteModelBaseUrl: https://api.deepseek.com/anthropic

    # Optional proxy mode:
    credentialProxyUpstream: https://api.deepseek.com/anthropic
    credentialProxyRemotePort: 47821
    modelCredentialRef: DEEPSEEK_API_KEY

    mirrorSessions: true
    mirrorPollMs: 1500
    mirrorMaxEvents: 2000
```

Remote agent override:

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

## Manual installer (debugging only)

```sh
node packages/installer/lib/cli.js plan --target user@host
node packages/installer/lib/cli.js doctor --target user@host
node packages/installer/lib/cli.js discover --target user@host
node packages/installer/lib/cli.js install --target user@host --start nohup
```

The normal plugin flow calls the same provisioning library.

## Updating

- Local plugin: quit DSH, run `./scripts/install-local.sh`, reopen.
- Remote agent: click **重新安装** on the host card.
- If a remote restart changes the port, click **重新发现**.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `等待远端 dsh web 就绪…` | The remote `webServer` files installed but the service did not write its state file. Common cause: a systemd user unit without the nvm Node bin in PATH. | Check `systemctl --user status dsh-remote-agent`; the installer now adds the bootstrap `$PATH`; reinstall/rebuild the local plugin, or use `remoteStart: nohup` |
| Install never finishes | SSH auth is interactive or remote lacks Node/npm | `ssh -o BatchMode=yes host true`; run `doctor`; inspect the card |
| `remote agent state file was not found` | Auto-provision disabled or remote start failed | Click **重新安装**; inspect `$DSH_HOME/remote-agent/web.log` |
| `does not accept POST` | Remote agent older than local plugin | Click **重新安装** |
| Remote workspace not in sidebar | Not added yet or sync pending | Use **Workspaces + → 远程新建工作区…**, or add it in **工作区** |
| Native session has no reply | No local key copied and remote has no credentials | Check **模型代理**; configure remote credentials |
| `DeepSeek Messages request failed (404)` | Proxy upstream points at the wrong provider root/path | Set `credentialProxyUpstream: https://api.deepseek.com/anthropic`; the fixed proxy preserves the `/anthropic` prefix and tolerates it already being on the request path; reinstall the local plugin |
| Approval appears locally but remote tool still fails | The decision was delivered but the tool failed remotely | Inspect the remote tool result |
| Duplicate native session after restart | Old mirror archive failed | Archive the old session in the sidebar; new mirrors use fresh IDs |
| Tunnel drops after sleep | SSH reset | Plugin reconnects; or click **连接** / **重新发现** |

### Logs

- Local plugin: DSH process stderr / desktop logs.
- Remote systemd: `journalctl --user -u dsh-remote-agent -f`.
- Remote nohup: `$DSH_HOME/remote-agent/web.log`.
- Local host registry: `$DSH_HOME/remote/hosts.json` (contains tokens; do not paste).
- Mirror map: `$DSH_HOME/remote/mirrors.json` (contains local/remote session ids).
- Remote state: `$DSH_HOME/remote-agent/agent.json` (contains a token; do not paste).

## Security checklist

- [ ] Remote DSH listens on `127.0.0.1` only.
- [ ] Tunnel binds `127.0.0.1` only.
- [ ] Host keys are verified or intentionally TOFU.
- [ ] Agent token and `hosts.json` are `0600`.
- [ ] `loopbackOnly` remains true unless a trusted authenticating proxy fronts the agent.
- [ ] The real model key is proxied, not copied to the remote host.
- [ ] Only trusted remote accounts are used; the remote DSH has their privileges.
