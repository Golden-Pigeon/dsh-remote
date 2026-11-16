/**
 * Resolve package-manager executables for build scripts.
 *
 * On Windows the `npm`/`pnpm` names on PATH are `.cmd` shims. `child_process`
 * cannot spawn them without a shell (`spawn('pnpm')` reports ENOENT), and
 * `shell: true` would pass arguments through `cmd.exe` unescaped. Both npm and
 * pnpm ship a real entry point next to the running Node installation, so use
 * that instead.
 *
 * Plain JavaScript so the `scripts/*.mjs` build tools can import it without a
 * TypeScript loader. Mirrors `packages/installer/src/npm.ts`.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** How to run npm from this process. */
export function npmInvocation(execPath = process.execPath, exists = existsSync) {
  const cli = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (exists(cli)) return { command: execPath, prefixArgs: [cli] }
  return { command: 'npm', prefixArgs: [] }
}

/** How to run pnpm from this process. */
export function pnpmInvocation(execPath = process.execPath, exists = existsSync, platform = process.platform) {
  const root = join(dirname(execPath), 'node_modules', 'pnpm')
  const native = join(root, 'pnpm.exe')
  if (platform === 'win32' && exists(native)) return { command: native, prefixArgs: [] }
  const cjs = join(root, 'bin', 'pnpm.cjs')
  if (exists(cjs)) return { command: execPath, prefixArgs: [cjs] }
  return { command: 'pnpm', prefixArgs: [] }
}
