# dsh-remote-local-plugin

Remote development that appears as ordinary local sessions.

## Supported environment

This plugin targets the official **DSH Desktop** application. Tested/supported versions:

- [DSH Desktop](https://github.com/deepseek-ai/deepseek-harness) [`0.2.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)
- Plugin [`0.8.11`](https://www.npmjs.com/package/dsh-remote-local-plugin)
- Remote DSH [`0.2.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)
- Remote [Node.js `22.19+`](https://nodejs.org/en/download) on Linux/macOS

Other DSH GUI plugins, forks, modified clients, and other DSH versions have not been tested. The
package dependency range is permissive for installation only; it is not a support guarantee.

## What it does

- Durable host registry at `$DSH_HOME/remote/hosts.json` (mode `0600`).
- SSH discovery of the remote agent's private state file.
- **Plugin-owned provisioning**: uploads the bundled `dsh-remote-agent` tarball, installs pnpm/DSH
  when missing, starts remote `dsh web`, waits for it, and connects. No separate installer command.
- One loopback SSH tunnel per host, health checks, exponential backoff, manual reconnect.
- Default direct key mode: the resolved local key is copied into the remote service environment.
- Optional reverse SSH forward and **local model credential proxy** for key-local deployments.
- **Native session mirror**: remote workspaces/sessions become local workspaces and Sessions in the
  ordinary sidebar. A small custom Agent façade routes prompts and cancellation to the remote agent
  while the normal Conversation UI renders the mirrored events.
- `+ 新会话` creates the remote session, creates its local mirror, and opens it through
  `uiWorkspace.openSession` — not a popup.
- Sidebar **+** menu to create a workspace locally (native flow) or on a connected remote host.
- SSH-backed remote workspace file listing/preview.
- Automatic remote Node.js discovery/install (nvm, Volta, fnm, Bun, asdf, mise, Nix, Homebrew, login shell; verified Node tarball fallback).
- Chinese / English client copy follows the DSH locale service.
- Remote SSH PTY terminals for mirror Sessions; local Sessions keep the local terminal.
- Remote approval questions bridged into the normal local approval UI.
- Model tools for every operation.
- Authenticated host API at `/api/dsh-remote` through DSH Connection's Fetch route.

## Install

### From the DSH plugin page

After the npm package is published, use **Plugins → Add plugin** and enter:

```text
dsh-remote-local-plugin
```

The package bundles the remote agent asset and the terminal-controller fork. Restart DSH after the
plugin page asks for it.

### From a source checkout

```sh
cd ../..
./scripts/install-local.sh          # desktop profile
./scripts/install-local.sh --profile web
```

The installer creates one tarball containing the terminal-controller fork; restart DSH after it
finishes.

## Use

1. **Settings → 远程开发**
2. Enter an SSH target (`my-host`) and click **保存并连接**.
3. Wait for `已连接` (first use installs the remote side).
4. Use **Workspaces +** to create a workspace; local folders use the native picker, remote folders
   use the SSH browser.
5. Create a session from the workspace row or Settings. The mirrored session opens in the normal
   Conversation UI.
6. Continue prompting. **Workspace files** and **New terminal** follow the selected Session.

## Boundaries

- The remote browser UI is intentionally not exposed by default; the remote API-remotes carrier is
  disabled so approvals reach the native local UI.
- Sessions over `mirrorMaxEvents` are not mirrored.
- On plugin restart, old mirrors are archived and recreated.

## Tools

`remote_hosts_list`, `remote_host_add`, `remote_host_connect`, `remote_host_provision`,
`remote_workspace_add`, `remote_workspaces_list`, `remote_session_create`, `remote_sessions_list`,
`remote_session_prompt`, `remote_session_snapshot`, `remote_session_cancel`.

## Configuration

See [`cordis.patch.yml`](cordis.patch.yml) and
[`examples/local-plugin.patch.yml`](../../examples/local-plugin.patch.yml).

## Security

The token stays local and is never returned to the browser. The browser uses DSH's authenticated
`/api` route. By default the model key is written to the remote service environment; set
`credentialProxy: true` to keep it local and inject it through the reverse-tunnel proxy. See the
[root README](../../README.md#security).
