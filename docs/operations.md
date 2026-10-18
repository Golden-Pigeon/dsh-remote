# Operations guide

This guide covers installing and running the local plugin and the remote agent, plus the failure modes
that show up most often in practice.

## Prerequisites

### Local machine

- DSH Desktop or a DSH Web/CLI installation with a profile that includes
  `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app`.
- `ssh` on `PATH`.
- Non-interactive SSH authentication: a key or ssh-agent. Password authentication works for the
  initial manual SSH session but cannot keep a background tunnel alive.
- The host key must be trusted. The default `accept-new` is TOFU; use `yes` after pre-populating
  `known_hosts`.

### Remote machine

- Linux or macOS. Windows remotes are not supported.
- Node.js 22.19+ and npm. The installer can find nvm, Volta, fnm, and Bun installations.
- An SSH server that accepts the local key/agent.
- Enough disk for a DSH install under `--install-dir` (or an existing `dsh` binary).
- Model credentials configured remotely, or the Phase 2 credential proxy. The installer never copies
  `DEEPSEEK_API_KEY`.

## Install the remote agent

From the workspace root after `pnpm build`:

```sh
node packages/installer/lib/cli.js plan --target user@host
```

`plan` prints the exact bash script that would run. Review it, then:

```sh
node packages/installer/lib/cli.js install --target user@host
```

Useful flags:

| Flag | Default | Purpose |
|---|---|---|
| `--profile` | `web` | Remote DSH profile that receives the agent |
| `--port` | `0` | Remote DSH Web port; 0 asks the OS |
| `--install-dir` | `$HOME/.local/share/dsh-remote` | Local-to-remote Node tool install root |
| `--dsh-home` | `$HOME/.dsh` | Remote DSH home |
| `--dsh-version` | `0.2.1-rc.2` | Pinned DSH runtime |
| `--start` | `systemd` | `systemd`, `nohup`, or `none` |
| `--no-start` | — | Same as `--start none` |
| `--json` | — | Machine-readable discover/pack output |

`systemd` mode writes `~/.config/systemd/user/dsh-remote-agent.service` and enables it. If the user
systemd manager is unavailable it falls back to `nohup` and writes a pid file under
`$DSH_HOME/remote-agent/web.pid`.

### Verify

```sh
node packages/installer/lib/cli.js doctor --target user@host --dsh-home /path/on/host
node packages/installer/lib/cli.js discover --target user@host --dsh-home /path/on/host
```

`discover` prints the live port and versions. It never prints the token. The token lives at
`$DSH_HOME/remote-agent/agent.json` with mode `0600`.

## Install the local plugin

1. Quit DSH Desktop completely (including the tray process).
2. Build and pack:

   ```sh
   cd packages/local-plugin
   npm pack
   ```

3. Install into the desktop profile with the CLI that belongs to the installation:

   ```sh
   dsh plugin --profile desktop add ./dsh-remote-local-plugin-0.1.0.tgz
   ```

4. Reopen DSH. **Settings → 远程开发** appears.
5. Add the SSH target. The plugin discovers the remote state file over SSH, opens a random loopback
   port, and connects to the agent.

The local plugin stores its registry at `$DSH_HOME/remote/hosts.json` (mode `0600`). The token is in
that file and is never returned by the authenticated host API.

## Configuration

Local plugin (`cordis.patch.yml` in the profile):

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

Remote agent (`cordis.patch.yml` in the remote profile):

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

Set `remoteStateFile` to an absolute path when the remote `DSH_HOME` is not `~/.dsh`.

## Updating

- **Remote agent:** re-run `install` after building a new tarball. `dsh plugin add` replaces the
  profile dependency; restart the service (`systemctl --user restart dsh-remote-agent` or restart the
  nohup process).
- **Local plugin:** quit DSH, run `dsh plugin add` with the new tarball, reopen.
- **Protocol:** bump `PROTOCOL_VERSION` only with a compatible client. A mismatch must be visible in
  the UI, not silently ignored.

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| `SSH discovery timed out` | Key/agent auth not working non-interactively, or host unreachable | Run `ssh -o BatchMode=yes user@host true`; check `ssh-add -l` |
| `remote agent state file was not found` | Installer did not run, wrong `DSH_HOME`, or `dsh web` not started | `installer discover --dsh-home <path>`; check the remote log |
| `agent is installed but its DSH web listener is not running` | `dsh web` exited | `systemctl --user status dsh-remote-agent`; inspect `$DSH_HOME/remote-agent/web.log` |
| `cannot get property "webServer"` in DSH logs | A plugin registered a naked `ctx.webServer` use without injecting the service | Use DSH Connection's `/api` Fetch route or inject the service properly |
| `protocol/version-mismatch` | Client and agent protocol revisions differ | Upgrade both packages; never force a downgrade |
| `auth/invalid` | Cached token is stale after a remote reset | Disconnect, remove the local host record, re-add it |
| Tunnel connects but API times out | Remote agent port changed after a restart | Use **重新发现**; the local plugin re-reads the state file |
| Remote UI opens but asks for a login | The launch token expired | Reopen **打开远端界面**; the local plugin requests a fresh path |
| Local plugin not listed in Settings | Plugin missing from the desktop profile or DSH not restarted | Check the profile package.json and restart DSH |

### Logs

- Local DSH: the process stderr / desktop logs.
- Remote systemd: `journalctl --user -u dsh-remote-agent -f`.
- Remote nohup: `$DSH_HOME/remote-agent/web.log`.
- Local host registry: `$DSH_HOME/remote/hosts.json` (contains tokens; do not paste publicly).
- Remote state: `$DSH_HOME/remote-agent/agent.json` (contains a token; do not paste publicly).

## Security checklist

- [ ] Remote DSH listens on `127.0.0.1` only.
- [ ] The tunnel binds `127.0.0.1` only.
- [ ] The remote agent token file is `0600`; the directory is `0700`.
- [ ] The local `hosts.json` is `0600`.
- [ ] `loopbackOnly` remains true.
- [ ] Host keys are verified or intentionally TOFU.
- [ ] Model credentials are not copied to the remote host.
- [ ] The remote account is a trusted account; its shell privileges are the agent's privileges.
