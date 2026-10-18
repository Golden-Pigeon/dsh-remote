# Agent instructions

This repository is intended to be public on GitHub.

## Before changing code

- Preserve the existing commit author identity; do not rewrite history or authors.
- Keep test hostnames, personal paths, tokens, and screenshots out of committed files.
- Local logs, screenshots, and test state may contain real values; only staged content matters.
- Do not bump the version for test-only tooling or documentation. The current release is 0.7.16.

## Verification commands

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Integration / UI tests

Never test against the user's primary DSH profile or production remote `~/.dsh`.

Use an isolated local test home:

```sh
./scripts/test-sandbox.sh
```

The script builds and installs the plugin into a fresh temporary `DSH_HOME`, starts a separate
`dsh web`, and prints its URL. It does not touch the desktop profile.

For a real remote test, use a separate remote profile too:

```yaml
- id: dsh-remote-local
  config:
    remoteDshHome: /tmp/dsh-remote-test-remote
    remoteInstallDir: /tmp/dsh-remote-test-install
    remoteStateFile: /tmp/dsh-remote-test-remote/remote-agent/agent.json
    remoteStart: nohup
```

Never create test workspaces in the production remote home.

## Test workspace visibility

Visibility is controlled by a test-only manifest in the test DSH home:

```text
$DSH_HOME/remote/test-visibility.json
```

```json
{
  "hiddenPaths": ["/tmp/dsh-remote-tests"],
  "hiddenWorkspaceIds": ["remote-workspace-id"]
}
```

This manifest is not a Settings UI option and not an agent tool. The local plugin reads it during
mirror sync.

### Choose based on the test

- **Backend/API/protocol tests**: write the path under `hiddenPaths` *before* creating the remote
  workspace. The remote workspace exists, but no local workspace or mirror session is registered.
- **UI/end-to-end tests**: create the workspace normally so it is visible, run the test, then add its
  remote workspace id (or exact path) to the manifest. The plugin archives local mirror sessions and
  removes the sidebar row. Remote data and local session logs are retained for later review.
- To review later, remove the manifest entry; the next sync restores the local mirror from the remote
  log.

Do not delete test workspaces just to clean the sidebar. Hide them, and preserve the data.

See [docs/testing.md](docs/testing.md) for the full workflow.
