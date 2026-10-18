# Changelog

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
