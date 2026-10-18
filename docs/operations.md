# Operations guide

The normal path is: install the local plugin once, then add an SSH host in Settings. The plugin
provisions the remote side itself.

## 1. Install the local plugin

Quit DSH Desktop completely (including the tray process), then:

```sh
cd /path/to/dsh-remote/dsh-remote
./scripts/install-local.sh
```

For a DSH Web profile:

```sh
./scripts/install-local.sh --profile web
# restart the DSH Web process after the script finishes
```

The script:

1. installs workspace dependencies;
2. builds all packages;
3. packs `dsh-remote-agent` and embeds it in the local plugin's `assets/`;
4. packs `dsh-remote-local-plugin`;
5. adds it to the chosen profile with the DSH CLI.

It refuses to touch the desktop profile while the desktop app is running.

## 2. Add a host

Open **Settings → 远程开发**, enter an SSH target (`user@host`, `host:port`, `ssh://…`, or an SSH
config alias), and click **保存并连接**.

The plugin then:

1. tries to read `<remoteDshHome>/remote-agent/agent.json` over SSH;
2. if no live agent exists and `autoProvision` is true:
   - uploads the bundled agent tarball;
   - runs the bootstrap script (`bash -s` over SSH);
   - installs pnpm and the pinned DSH under `remoteInstallDir` when missing;
   - adds the agent to the remote `web` profile;
   - starts `dsh web` on `127.0.0.1` using systemd or nohup;
3. waits for the state file and connects the loopback tunnel;
4. starts the local credential proxy and adds a reverse SSH forward when a local model key exists.

The host card shows `安装中`, `正在连接`, then `已连接`. Errors appear on the card; fix SSH and click
**重新安装** to retry.

## 3. Add a remote workspace

Click **工作区**, enter an existing absolute remote directory, and click **添加工作区**. The directory
must already exist on the remote machine. The workspace appears in the list with its session count.

## 4. Chat or open the full remote UI

- **+ 新会话** creates a remote DSH session inside that workspace. The chat drawer polls the committed
  transcript, sends prompts, and can cancel the active turn.
- **开始使用** opens the full remote DSH UI through the tunnel (files, terminal, diffs, approvals,
  tools).

The local drawer is deliberately small: it is a convenience client for the remote session. Long
sessions and advanced interactions belong in the full remote UI.

## Model credentials

The preferred path is the local credential proxy:

- the local plugin resolves `DEEPSEEK_API_KEY` from the local DSH credential store at connect time;
- the remote DSH is started with `DEEPSEEK_BASE_URL=http://127.0.0.1:47821` and a placeholder key;
- the SSH tunnel adds `-R 127.0.0.1:47821:127.0.0.1:<local-proxy-port>`;
- the local proxy injects the real key and forwards to `credentialProxyUpstream`.

The real key is never written to the remote host. The reverse forward is reachable only on the remote
loopback interface while the tunnel is up; connect only trusted hosts.

If no local key is available, set `credentialProxy: false` or configure credentials in the remote DSH
UI. The plugin still installs and connects; model calls use whatever the remote host has.

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

    credentialProxy: true
    credentialProxyUpstream: https://api.deepseek.com
    credentialProxyRemotePort: 47821
    modelCredentialRef: DEEPSEEK_API_KEY
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

The installer remains available for diagnosing a host without the UI:

```sh
node packages/installer/lib/cli.js plan --target user@host
node packages/installer/lib/cli.js doctor --target user@host
node packages/installer/lib/cli.js discover --target user@host
node packages/installer/lib/cli.js install --target user@host --start nohup
```

The normal plugin flow calls the same provisioning library.

## Updating

- Local plugin: quit DSH, run `./scripts/install-local.sh`, reopen.
- Remote agent: click **重新安装** on the host card. This re-uploads the currently bundled agent and
  restarts the remote `dsh web` with the same host/state path.
- If a remote restart changes the port, click **重新发现**.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| Install never finishes | SSH auth is interactive or the remote lacks Node/npm | `ssh -o BatchMode=yes host true`; run `doctor`; inspect the host card error |
| `remote agent state file was not found` | Auto-provision disabled or remote start failed | Click **重新安装**; inspect `$DSH_HOME/remote-agent/web.log` |
| `remote agent: ... does not accept POST` | Remote agent is older than the local plugin | Click **重新安装** |
| `已连接` but no reply | No local model key and no remote credentials | Configure remote credentials, or set a local key and reconnect |
| Add workspace fails | Directory missing or not absolute | Create the directory on the remote host; use its absolute path |
| Remote UI asks for login | Launch URL expired | Click **开始使用** again |
| `protocol/version-mismatch` | Local plugin and remote agent revisions differ | Reinstall the remote agent from the local plugin |
| Tunnel drops after sleep | SSH connection reset | The plugin reconnects; or click **连接** / **重新发现** |

### Logs

- Local plugin: DSH process stderr / desktop logs.
- Remote systemd: `journalctl --user -u dsh-remote-agent -f`.
- Remote nohup: `$DSH_HOME/remote-agent/web.log`.
- Local host registry: `$DSH_HOME/remote/hosts.json` (contains tokens; do not paste).
- Remote state: `$DSH_HOME/remote-agent/agent.json` (contains a token; do not paste).

## Security checklist

- [ ] Remote DSH listens on `127.0.0.1` only.
- [ ] The tunnel binds `127.0.0.1` only.
- [ ] Host keys are verified or intentionally TOFU.
- [ ] The remote agent token file and local `hosts.json` are `0600`.
- [ ] `loopbackOnly` remains true unless a trusted authenticating proxy fronts the agent.
- [ ] The local model key is proxied, not copied to the remote host.
- [ ] The remote account is trusted; the remote DSH has the remote user's privileges.
