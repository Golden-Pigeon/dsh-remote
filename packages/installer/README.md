# @dsh-remote/installer

`dsh-remote-install` bootstraps `dsh-remote-agent` on an SSH host. The local plugin calls the same
provisioning library automatically; the CLI is for manual diagnostics.

```sh
node packages/installer/lib/cli.js install --target user@host
node packages/installer/lib/cli.js plan --target user@host
node packages/installer/lib/cli.js doctor --target user@host
node packages/installer/lib/cli.js discover --target user@host
node packages/installer/lib/cli.js tunnel --target user@host
node packages/installer/lib/cli.js pack
```

The bootstrap script:

1. finds Node.js (including nvm/Volta/fnm/Bun installations) and checks 22.19+;
2. installs pnpm and the pinned `@deepseek-ai/dsh` into `--install-dir` when missing;
3. adds the agent tarball to the chosen remote profile;
4. starts `dsh web` on `127.0.0.1` using a systemd user unit or `nohup`;
5. waits for the agent state file and prints the port.

It never copies model API keys. See [`docs/operations.md`](../../docs/operations.md).
