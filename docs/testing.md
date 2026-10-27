# Test workspace visibility

This repository uses a **test-only manifest** to keep development workspaces out of the desktop
sidebar. It is not a Settings option and not an agent tool.

The manifest lives only in the test DSH home:

```text
$DSH_HOME/remote/test-visibility.json
```

```json
{
  "hiddenPaths": ["/tmp/dsh-remote-tests"],
  "hiddenWorkspaceIds": ["remote-workspace-id"]
}
```

The local plugin reads it during mirror reconciliation.

## Which form to use

- **Backend/API/protocol tests that do not need the desktop UI**
  - Write the path under `hiddenPaths` before creating the remote workspace.
  - The remote workspace and its sessions still exist; no local workspace or mirror session is
    registered, so nothing appears in the sidebar.

- **UI/end-to-end tests that must see the session**
  - Create the workspace normally and run the test.
  - Afterward add its remote workspace id (or exact path) to the manifest.
  - The plugin archives the local mirror sessions and removes the local workspace row. Remote data and
    local session logs are retained for later review.

## Restore for review

Remove the path/id from the manifest. On the next sync the plugin unarchives the local mirror sessions
and recreates the local workspace from the remote log.

No UI control and no agent tool is involved. The manifest is only present in test profiles; a normal
profile has no manifest and mirrors remote workspaces normally.

## Mirror regression checks

After `pnpm -r build`, run the focused checks from the repository root:

```sh
pnpm --filter dsh-remote-local-plugin exec node --import tsx --test test/mirror_lifecycle.test.ts test/mirror-subagents.test.ts
```

The mirror fixture uses real Cordis contexts and scope disposal with in-memory remote services. It covers model selection and forwarding, explicit choices matching deployment defaults, recorded-model precedence, asynchronous shutdown and subagent pruning, and native resume attempted before persisted mirror mappings finish loading. Ordinary local Agents and the remote façade remain admissible.

CI retains the frozen rc.2 development baseline and runs a second job with all installed DSH dependencies and peers pinned to rc.3. Neither job installs into a user's DSH profile or calls a model provider. Changes to the mirror's Agent interface must pass both targets.
