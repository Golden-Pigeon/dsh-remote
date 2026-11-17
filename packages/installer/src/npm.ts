/**
 * Locating a usable npm executable.
 *
 * On Windows the `npm` name on PATH is a `.cmd` shim that
 * `child_process` cannot spawn without a shell. npm installed next to Node
 * has a real `node_modules/npm/bin/npm-cli.js`; use it and never spawn the
 * shim.
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
  platform: NodeJS.Platform = process.platform,
): ToolInvocation {
  // <node dir>/node_modules/npm/bin/npm-cli.js — the standard layout of the
  // official Windows installer and nvm-windows.
  const cli = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (exists(cli)) return { command: execPath, prefixArgs: [cli] }
  // POSIX npm is an executable symlink on PATH. On Windows a bare npm is a
  // .cmd shim, which child_process cannot spawn, so fail with a readable cause.
  if (platform === 'win32') {
    throw new Error('npm entry point not found next to Node; use a standard Node.js installation')
  }
  return { command: 'npm', prefixArgs: [] }
}
