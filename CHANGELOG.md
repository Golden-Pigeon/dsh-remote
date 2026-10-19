# Changelog

## 0.8.9

- Forward image attachments from a mirrored prompt to the remote Session, including ordered text
  and image content. The remote agent admits the images through the remote DSH attachment store.
- Allow the remote file adapter to open any absolute remote path, not only paths under the mirrored
  workspace; remote transcript links and editor paths can now read arbitrary host files.
- Increase the remote prompt request body bound for normalized image payloads.
- Publish the mirror Agent as running as soon as a remote `turn/start` arrives, so a session opened
  while its remote turn is active exposes steering instead of a disabled submit control.
- Start the remote workspace folder picker at the account's home directory (`~`) instead of the
  remote DSH home (`.dsh`).
- Keep a typed trailing slash in the workspace folder picker while navigating into a subdirectory.

## 0.8.8

- Forward a mirrored Session's `sandbox/mode` change to its remote Session instead of only updating
  the local projection, so switching a remote Session to `danger-full-access` takes effect on the
  remote Bash/filesystem sandbox.
- On reattach, compare the local and remote sandbox modes and repair a previously unsynchronized
  mode once.
- Add the remote agent `POST /sessions/:id/sandbox` endpoint with strict mode validation.

## 0.8.7

- Hide remote subagent Sessions from the Workspaces sidebar and remote session picker. The remote
  agent now projects `origin: "subagent"` / `parentSession`, and the local mirror archives any
  subagent sessions created by earlier releases. Remote subagent data and logs are left intact.

## 0.8.6

- Automatically migrate a legacy `dsh-remote-agent` entry out of the remote DSH profile during
  Reinstall. The installer backs up `package.json` and the stale lockfile, removes the old dependency
  and bundle entry, then installs the scoped npm agent. Existing remote plugins such as `dsh-mnemon`
  are preserved; no manual SSH profile editing is required.

## 0.8.5

- Add a **Restart remote DSH** host action and `remote_host_restart` agent tool. It restarts the
  installer-owned systemd unit, waits for the agent state file, and reconnects without reinstalling
  DSH or overwriting the remote profile. Nohup deployments still use Reinstall or a manual restart.
- Publish the remote agent as `@goldenpigeon/dsh-remote-agent` and install it from npm before falling
  back to the bundled tarball.
- Keep the bundled agent artifact under the installer's persistent artifacts directory instead of a
  temporary `/tmp` path, so later plugin installations cannot break on a missing file dependency.
- Retain remote-only plugins such as `dsh-mnemon` when updating the remote agent.
- Hide remote subagent Sessions from mirrored workspaces and the remote session picker; existing
  subagent mirrors are archived during the next sync.

## 0.8.4

- Keep mirrored Session identity stable across plugin reloads and ended turns; reattach the runtime
  instead of recreating the local Session, stopping sidebar flicker.
- Stream remote Session events over SSE and forward dense Assistant start/chunk/end frames into the
  local Agent stream for token-level reasoning and text output.
- Suppress incomplete transient tool-call cards; durable tool results own the final card state.
- Publish `agent/status` transitions so the Stop control reflects the mirrored Agent's running state.
- Read the per-session model selection from the local projection/default and forward provider, model,
  and reasoning effort to the remote Session.
- Remap `sourceEventSeqs` and surface ranges from remote to local Session sequence numbers.
- Normalize remote absolute file paths and abort cancelled remote file reads.
- Propagate the remote proxy into the systemd/nohup runtime environment for model requests.

## 0.8.3

- Detect the remote installer proxy through the account's actual login shell, including zsh, fish,
  and other shell-specific login/interactive startup files, instead of hard-coding bash.
- Propagate the detected proxy into the remote systemd unit (and nohup process) so model calls use it
  after installation, not only package downloads.

## 0.8.2

- Use a remote-visible HTTP(S) proxy for installer downloads. The bootstrap reads
  `HTTPS_PROXY`/`HTTP_PROXY` from the remote login and interactive shells, and supports explicit
  `remoteInstallProxy`/`remoteInstallNoProxy` configuration.
- Include the last bootstrap stderr lines in provisioning failures.
- Show staged remote-install progress across upload, proxy, Node.js, pnpm, DSH, agent, service,
  state-file, tunnel, and health phases.

## 0.8.1

- Show staged remote-install progress in the host card: upload, Node.js, pnpm, DSH, agent,
  service start, state-file wait, tunnel, and health checks.
- Stream installer output into the local progress callback without exposing raw logs.

## 0.8.0

- Publish one installable `dsh-remote-local-plugin` package.
- Bundle `dsh-remote-terminal-controller` inside the plugin and merge its bundle patch.
- Add the DSH plugin-page installation path.
- Add online metadata, CI, release workflow, and release documentation.
- Harden systemd unit permissions, credential-proxy authentication, terminal fallback, approval
  gating, and remote file/terminal resource limits.

## 0.7.16

- Truncate oversized remote text lines and bound remote file page sizes.

## 0.7.15

- Use mode `0600` for the remote systemd unit that may contain a model key.
- Add per-host credential-proxy tokens and model-key fingerprint reconciliation.
- Refuse to fall back to a local terminal when a mirrored remote terminal fails.
- Bound terminal output queues and clean up aborted terminal waiters.
- Serialize mirror state writes.
- Bound installer output and handle stdin errors.
- Require approval for agent host-write tools.

## 0.7.14

- Add automatic remote Node.js discovery/install with checksum verification.

## 0.7.13

- Add live remote folder filtering and native local directory selection.

## 0.7.12

- Follow the DSH locale service with English/Chinese client copy.

## 0.7.11

- Add unified workspace creation and remote directory browsing.
