# Changelog

## Unreleased

- Detect an outdated remote DSH runtime and offer a manual, non-blocking update from Settings.
  The installer replaces the remote runtime, restarts the service, and reconnects
  ([#12](https://github.com/Golden-Pigeon/dsh-remote/pull/12)).
- Show the retry attempt, countdown, and failing stage during reconnects, and keep transient host
  API failures from overwriting the install/connect status
  ([#12](https://github.com/Golden-Pigeon/dsh-remote/pull/12)).

## 0.8.12

- Tolerate approval-stream heartbeat events and recover a mirrored turn abandoned by a remote host
  restart, so approvals keep reaching the local UI after reconnects
  ([#1](https://github.com/Golden-Pigeon/dsh-remote/issues/1),
  [#2](https://github.com/Golden-Pigeon/dsh-remote/issues/2),
  [#3](https://github.com/Golden-Pigeon/dsh-remote/pull/3)).
  Thanks [@XuHuaiyu](https://github.com/XuHuaiyu)!
- Coalesce concurrent mirror creation per remote Session, preventing duplicate local rows for one
  remote Session
  ([#4](https://github.com/Golden-Pigeon/dsh-remote/issues/4),
  [#5](https://github.com/Golden-Pigeon/dsh-remote/pull/5)).
  Thanks [@XuHuaiyu](https://github.com/XuHuaiyu)!
- Mirror remote subagent Sessions as local subagent children of their mirrored parent instead of
  hiding them. A mirrored parent transcript carries the remote `subagent/catalog`, so opening one of
  its subagent conversations previously failed with `subagent/not-found`. Children keep the remote
  Session id, never attach to a Workspaces row, and are pruned only when the remote stops reporting
  them. A child whose mirror window lost its `subagent/descriptor` is skipped with a warning
  ([#8](https://github.com/Golden-Pigeon/dsh-remote/issues/8),
  [#9](https://github.com/Golden-Pigeon/dsh-remote/pull/9)).
  Thanks [@NoidLiu](https://github.com/NoidLiu)!

## 0.8.11

- Stop mirroring internal remote context messages (`compact-checkpoint`, `agent-instructions`,
  `runtime-context`, `skill-catalog`) as if they were user prompts. A large checkpoint previously
  stalled the local mirror and left the live transcript behind.
- Drop late Assistant stream chunks once the matching durable `assistant/message` has been appended.
  The poll and stream channels can arrive out of order; injecting a late transient chunk after the
  durable message made the client conversation assembler fail with `non-appended Match` and stop its
  live event feed until the user switched Sessions.
- Renumber forwarded Assistant chunks and their terminal index so the client's `nextIndex` matches
  the end frame after transient `tool-call-delta` chunks are omitted.
- Remove the turn-end synthetic Assistant settlement; durable step/turn boundaries are authoritative.

## 0.8.10

- Support mirroring remote Sessions longer than the remote snapshot window by seeding from the first
  complete turn in the available tail. Local history starts from that turn; older remote history stays
  in the remote Session.
- Treat remote surface replacement events as local appends, both during seed and live mirroring. A
  replacement range refers to the remote log and can target a node omitted from the local mirror,
  which previously poisoned the local surface projection and made history fail to load.
- When a poll finds the remote log has advanced past the mirror window, skip to the available tail and
  continue mirroring instead of stopping the mirror.

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
- Publish a local `agent/error` when a mirrored prompt cannot reach the remote host instead of only
  logging the failure.
- Never fall back to creating a local Session when the native New Session action targets a
  mirrored remote workspace and the host is unavailable; show an error instead.
- Read normalized image metadata from the attachment reference returned by `readImage` (`ref.mediaType`),
  fixing remote image prompts being rejected as an invalid content part.
- Map Assistant stream `startedAfterSeq` from remote to local sequence numbers instead of dropping it;
  the client needs the local boundary to settle the final Assistant message.
- Remap `developer/message.headerSeq` from remote to local sequence numbers; a stale header reference
  previously stopped the mirror mid-turn and left the UI waiting forever.
- Keep queued/steer messages in the mirror Agent's local pending inbox while a remote turn is
  running. Pressing Enter no longer forwards them immediately; edit/delete and the steer arrow are
  resolved by the local inbox, and queued next-turn messages are forwarded when the remote turn
  completes. Aborting a turn clears the pending inbox.
- Preserve each remote Session's original `createdAt` when recreating its local mirror Session after a
  restart, so the sidebar no longer shows every restored remote session as "now" and time ordering
  remains stable.

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
