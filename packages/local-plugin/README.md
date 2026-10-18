# dsh-remote-local-plugin

Remote development that appears as ordinary local sessions.

## What it does

- Durable host registry at `$DSH_HOME/remote/hosts.json` (mode `0600`).
- SSH discovery of the remote agent's private state file.
- **Plugin-owned provisioning**: uploads the bundled `dsh-remote-agent` tarball, installs pnpm/DSH
  when missing, starts remote `dsh web`, waits for it, and connects. No separate installer command.
- One loopback SSH tunnel per host, health checks, exponential backoff, manual reconnect.
- Reverse SSH forward for the **local model credential proxy**; the real API key never goes to the
  remote host.
- **Native session mirror**: remote workspaces/sessions become local workspaces and Sessions in the
  ordinary sidebar. A small custom Agent façade routes prompts and cancellation to the remote agent
  while the normal Conversation UI renders the mirrored events.
- `+ 新会话` creates the remote session, creates its local mirror, and opens it through
  `uiWorkspace.openSession` — not a popup.
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
4. Click **工作区**, add an existing remote directory.
5. Click **+ 新会话**. The mirrored session opens in the normal Conversation UI.
6. Continue prompting, or click **开始使用** for the full remote UI.

## Mirror boundaries

- Approval prompts are not bridged; use the full remote UI for approval-heavy tools.
- The local workspace anchor is metadata; the remote file tree/terminal is in the full remote UI.
- Sessions over `mirrorMaxEvents` are not mirrored.
- On plugin restart, old mirrors are archived and recreated.

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
key. See the [root README](../../README.md#security).
