# Contributing

## Requirements

- Node.js 22.19 or newer
- pnpm 11.21.0 (the version declared by the workspace)
- DSH 0.2.1-rc.2 for the compatibility target

## Setup

```sh
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

`pnpm verify` runs the build and test suite.

## Development boundaries

- `packages/local-plugin` is the installable DSH plugin. Its build produces the host/client bundles
  and the bundled remote-agent tarball.
- `packages/terminal-controller` is bundled into the local plugin. Keep its patch compatible with the
  main plugin patch.
- `packages/remote-agent` runs on the remote DSH host.
- `packages/installer` is the remote bootstrap implementation.
- `packages/protocol` is the shared wire contract. Change it only with matching client/agent tests.

Do not commit generated `lib/` output, tarballs, local DSH state, or credentials. `.secret/` is
intentionally ignored.

## Testing

Use an isolated DSH home:

```sh
./scripts/test-sandbox.sh
```

Never create test workspaces or sessions in the primary `~/.dsh` profile. See
[docs/testing.md](docs/testing.md) for visibility controls.

For a release bundle:

```sh
node scripts/release-plugin.mjs
```

The resulting tarball includes the terminal-controller fork as a bundled dependency.

## Pull requests

- Keep changes focused and include tests where behavior changes.
- Run `pnpm -r typecheck`, `pnpm -r test`, and `pnpm -r build` before opening a PR.
- Do not rewrite published tags or history.
- Describe security-sensitive changes explicitly, especially anything touching credentials, remote
  installation, approvals, tunnels, or terminal execution.
