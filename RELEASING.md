# Releasing

## Prerequisites

- npm account with publish access to `dsh-remote-local-plugin`
- GitHub repository write access
- `NPM_TOKEN` stored as a GitHub Actions secret for automated releases

## Build the installable bundle

```sh
pnpm install --frozen-lockfile
pnpm -r build
node scripts/release-plugin.mjs
```

`release-plugin.mjs` creates one package tarball. The terminal-controller fork is copied into
`node_modules/dsh-remote-terminal-controller` and declared as a bundled dependency, so DSH users only
install `dsh-remote-local-plugin`.

## Publish automatically

The normal path is tag-driven:

1. Bump `packages/local-plugin/package.json` to the next version.
2. Commit and push `main`.
3. Create and push the matching tag:

```sh
git tag v<version>
git push origin v<version>
```

The `Release` workflow uses the `NPM_TOKEN` repository secret to publish the bundled tarball. It
skips npm publishing when that exact version already exists, then attaches the tarball to the GitHub
release. The token is stored in `.secret/npm_token` locally; `.secret/` is ignored and must never be
committed.

Manual publish is only a fallback:

```sh
npm publish packages/local-plugin/dsh-remote-local-plugin-<version>.tgz --access public
```

Then verify in a clean DSH profile:

```text
Plugins → Add plugin → dsh-remote-local-plugin → Install → Restart
```

## Release through GitHub Actions

1. Add the `NPM_TOKEN` repository secret.
2. Update the version in `packages/local-plugin/package.json`.
3. Commit and push.
4. Tag and push:

```sh
git tag v<version>
git push origin v<version>
```

The `Release` workflow builds the workspace, creates the bundled tarball, publishes it to npm, and
attaches the tarball to the GitHub release.

## Compatibility

Keep `dsh.compatibility.dsh` aligned with the DSH releases exercised by `pnpm -r test`. The current
supported and tested client is the official [DSH Desktop](https://github.com/deepseek-ai/deepseek-harness) [`0.2.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2); other DSH GUI plugins, forks,
modified clients, non-DSH GUIs, and other DSH versions have not been tested.
