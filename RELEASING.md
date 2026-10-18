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

## Publish manually

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
test target is DSH `0.2.1-rc.2`.
