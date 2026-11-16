# Development

## Workspace layout

This is a pnpm workspace. Packages reference each other with `workspace:*`, which pnpm links as a
junction straight into the source directory:

```
packages/local-plugin/node_modules/@dsh-remote/installer -> ../../installer
```

A link resolves the **package**, but Node and TypeScript still read the package's `main` and `types`
fields, and those point at `lib/`:

```json
{ "main": "lib/index.js", "types": "lib/types/index.d.ts" }
```

`lib/` is gitignored, because it is build output.

## The rule that follows from that

> Editing a package's `src` does not change what its consumers see until you rebuild it.

If you skip the rebuild, the consuming package's typecheck reads the old bundle and reports
something like:

```
error TS2305: Module '"@dsh-remote/installer"' has no exported member 'InstallerError'
```

…for a symbol that plainly exists in `src`. The error describes the stale artefact, not your edit,
so it sends you looking in the wrong place.

Either of these avoids it:

```sh
pnpm build          # rebuild everything
pnpm --filter @dsh-remote/installer build    # rebuild one package
```

## Automatic guard

`pnpm typecheck` runs `scripts/check-workspace-libs.mjs` first (through the `pretypecheck` hook). It
compares each package's built `main`/`types` against the newest file under its `src`, and stops with
an actionable message instead of letting the stale-artefact error surface:

```
Workspace builds are out of date:
  @dsh-remote/installer  lib/index.js is stale
Run "pnpm build" (or build @dsh-remote/installer) before typechecking.
```

The check is a timestamp heuristic: it catches "edited but never rebuilt", which is the mistake that
actually happens. It cannot prove a build is semantically current — `pnpm build` still owns that.

## Building

```sh
pnpm build      # all packages, dependency order
pnpm typecheck  # type checking only
pnpm test       # each package's own test runner
pnpm verify     # build + test
```

Per-package build scripts are plain arguments, not POSIX environment prefixes:

```sh
node ../../scripts/build-host.mjs --entry src/bin.ts --out lib/cli.js --cli
```

That form works on Windows too, where `VAR=1 command` is not understood by the shell npm uses.
`scripts/build-host.mjs` still honours `DSH_REMOTE_HOST_ENTRY`, `DSH_REMOTE_HOST_OUT` and
`DSH_REMOTE_CLI` for callers that set them; an explicit argument wins.

## npm and pnpm on Windows

On Windows, the `npm` and `pnpm` names on `PATH` are `.cmd` shims. `child_process` cannot spawn them
without a shell (`spawn('npm')` gives `ENOENT`, `spawn('npm.cmd')` gives `EINVAL`), and
`shell: true` would pass arguments through `cmd.exe` unescaped.

Build tooling therefore resolves a real entry point next to the running Node installation instead:

- npm → `node <node dir>/node_modules/npm/bin/npm-cli.js`
- pnpm → `<node dir>/node_modules/pnpm/pnpm.exe` on Windows,
  `node <node dir>/node_modules/pnpm/bin/pnpm.cjs` elsewhere

That logic lives in `scripts/package-manager.mjs` for the build scripts (plain JavaScript) and in
`packages/installer/src/npm.ts` for the installer. Both fall back to the bare command name when no
entry point is found, so POSIX systems behave exactly as before.
