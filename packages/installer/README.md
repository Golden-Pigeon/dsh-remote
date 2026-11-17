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

The installer itself never resolves credentials. The local plugin owns that decision and exposes
two choices, each with a global default and a per-host override:

**Direct (default).** `copyModelKey: true` / `credentialProxy: false`. The plugin resolves
`DEEPSEEK_API_KEY` from the local credential store and provisioning writes it into the remote
`dsh web` environment (`Environment="DEEPSEEK_API_KEY=…"` in the systemd user unit, or the `nohup`
environment). The remote host then calls the provider directly, so **the key is present on the
remote host**. Use this on a remote account you trust. Settings exposes global defaults for **Use
local credential proxy** and **Copy model API key to remote hosts**; each host can override either
choice, and the host setting wins. Turn copying off to keep the key local and configure credentials
on the remote instead.

**Proxy.** Enable **Use local credential proxy**. The key never leaves the local machine;
`copyModelKey` is unused for that host.
The remote host is started with `DEEPSEEK_BASE_URL=http://127.0.0.1:47821` and a placeholder key,
and the tunnel adds a reverse forward
`-R 127.0.0.1:47821:127.0.0.1:<local proxy port>`. The local proxy injects the real key and
forwards to `credentialProxyUpstream`.

When running the CLI by hand, no model flags exist: a manual CLI install does not configure model
credentials. The plugin copies or omits the key according to the effective global/per-host choice
when it connects or reinstalls a host. See
[`docs/operations.md`](../../docs/operations.md) for the full comparison and troubleshooting.
