# dsh-remote-local-plugin

Remote development inside DSH: one Settings page that provisions the remote host, adds projects,
creates sessions, and chats.

## What it does

- Durable host registry at `$DSH_HOME/remote/hosts.json` (mode `0600`).
- SSH discovery of the remote agent's private state file.
- **Plugin-owned provisioning**: uploads the bundled `dsh-remote-agent` tarball, installs pnpm/DSH
  when missing, starts remote `dsh web`, waits for it, and connects. No separate installer command.
- One loopback SSH tunnel per host, health checks, exponential backoff, manual reconnect.
- Reverse SSH forward for the **local model credential proxy**; the real API key never goes to the
  remote host.
- Remote workspace creation, session creation, prompt/cancel, snapshot polling, and a chat drawer.
- `开始使用` opens the full remote DSH UI through the same tunnel.
- Model tools for every operation.
- Authenticated host API at `/api/dsh-remote` through DSH Connection's Fetch route.

## Install

```sh
cd ../..
./scripts/install-local.sh          # desktop profile
./scripts/install-local.sh --profile web
```

Quit DSH Desktop before installing the desktop profile.

## Use

1. **Settings → 远程开发**
2. Enter an SSH target (`example-host`) and click **保存并连接**.
3. Wait for `已连接` (first use installs the remote side).
4. Click **工作区**, add an existing remote directory, then **+ 新会话**.
5. Send prompts in the drawer, or click **开始使用** for the full remote UI.

## Tools

`remote_hosts_list`, `remote_host_add`, `remote_host_connect`, `remote_host_provision`,
`remote_workspace_add`, `remote_workspaces_list`, `remote_session_create`, `remote_sessions_list`,
`remote_session_prompt`, `remote_session_snapshot`, `remote_session_cancel`, `remote_web_url`.

## Configuration

See [`cordis.patch.yml`](cordis.patch.yml) and
[`examples/local-plugin.patch.yml`](../../examples/local-plugin.patch.yml).

## Security

The token stays local and is never returned to the browser. The browser uses DSH's authenticated
`/api` route. The model key is injected by the local proxy; the remote DSH receives only a placeholder
key. See the [root README](../../README.md#security-model).
