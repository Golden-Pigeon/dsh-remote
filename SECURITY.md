# Security Policy

## Supported versions

Security fixes are applied to the latest published `0.8.x` release. The plugin follows DSH
pre-release API changes; older releases may not receive backports.

The supported client is the official [DSH Desktop](https://github.com/deepseek-ai/deepseek-harness) [`0.2.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)
application, with remote DSH [`0.2.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2) and [Node.js `22.19+`](https://nodejs.org/en/download). Other DSH GUI plugins, forks, modified clients, non-DSH GUIs, and
other DSH versions have not been tested. A wider dependency range in `package.json` is an
installation allowance, not a support guarantee.

## Reporting a vulnerability

Please use the repository's **Security → Report a vulnerability** flow to open a private security
advisory:

https://github.com/Golden-Pigeon/dsh-remote/security/advisories/new

Do not open a public issue for a vulnerability that could expose credentials, execute commands, or
affect remote hosts. Include the affected version, reproduction steps, and whether the issue affects
local DSH, the remote agent, or the installer.

## Threat model

- The local plugin runs with the same privileges as the local DSH process.
- Remote provisioning runs as the SSH account and may install Node.js, pnpm, DSH, and the remote agent
  in that account.
- The remote host is trusted. A compromised remote account can control its own DSH runtime and can
  affect the mirrored transcript.
- In the default direct-key mode, the resolved model API key is written to the remote service
  environment. Use this only with a trusted remote account. The systemd unit has mode `0600`.
- In credential-proxy mode, the real key remains local. The remote side receives a per-host proxy
  token; the local proxy rejects requests without one. A compromised process running as the same
  remote Unix user may still use the tunnel, so this is not a boundary against a fully compromised
  remote account.
- SSH host keys default to `accept-new` (TOFU). Configure `strictHostKeyChecking: yes` with a prepared
  `known_hosts` for strict verification.
- Never commit real credentials, `.secret/`, local host records, or remote state files to Git.

## Hardening notes

- Remote agent endpoints bind loopback only and require bearer authentication.
- Local host records and remote agent state files use mode `0600`.
- The plugin does not include hidden telemetry. It contacts the configured npm registry, nodejs.org
  when automatic Node.js installation is enabled, the configured model endpoint, and the SSH host.
