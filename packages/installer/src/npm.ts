/**
 * Locating a usable package-manager executable.
 *
 * On Windows the `npm`/`pnpm` names on PATH are `.cmd` shims that
 * `child_process` cannot spawn without a shell, and `shell: true` would pass
 * arguments through `cmd.exe` unescaped. Both npm and pnpm ship a real entry
 * point next to the running Node installation, so prefer that:
 *
 * - npm  → `node <node dir>/node_modules/npm/bin/npm-cli.js`
 * - pnpm → `<node dir>/node_modules/pnpm/pnpm.exe` on Windows,
 *          `node <node dir>/node_modules/pnpm/bin/pnpm.cjs` elsewhere
 *
 * @module @dsh-remote/installer/npm
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** One executable plus the leading arguments that invoke a tool. */
export interface ToolInvocation {
  readonly command: string
  readonly prefixArgs: readonly string[]
}

/** Kept as an alias so callers that only need npm read clearly. */
export type NpmInvocation = ToolInvocation

/** How to run npm from this process. */
export function npmInvocation(
  execPath: string = process.execPath,
  exists: (path: string) => boolean = existsSync,
): ToolInvocation {
  // <node dir>/node_modules/npm/bin/npm-cli.js — the standard layout of both the
  // official installers and most version managers.
  const cli = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (exists(cli)) return { command: execPath, prefixArgs: [cli] }
  return { command: 'npm', prefixArgs: [] }
}

/** How to run pnpm from this process. */
export function pnpmInvocation(
  execPath: string = process.execPath,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): ToolInvocation {
  const root = join(dirname(execPath), 'node_modules', 'pnpm')
  // The standalone pnpm package ships a native binary on Windows and a JS
  // entry point on POSIX; neither needs a shell.
  const native = join(root, 'pnpm.exe')
  if (platform === 'win32' && exists(native)) return { command: native, prefixArgs: [] }
  const cjs = join(root, 'bin', 'pnpm.cjs')
  if (exists(cjs)) return { command: execPath, prefixArgs: [cjs] }
  return { command: 'pnpm', prefixArgs: [] }
}


