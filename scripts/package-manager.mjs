/**
 * Resolve package-manager executables for build scripts.
 *
 * On Windows the `npm`/`pnpm` names on PATH are `.cmd` shims.
 * `child_process` cannot spawn them without a shell, and `shell: true` would
 * pass arguments through cmd.exe unescaped. A script launched by pnpm can use
 * `npm_execpath` (the real JS entry point); npm installed next to Node has a
 * real `npm-cli.js`. Never spawn a shell shim.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SHELL_SHIM = /\.(?:cmd|bat|ps1)$/iu
const JS_ENTRY = /\.(?:cjs|mjs|js)$/iu

/**
 * How to run the package manager that launched this script.
 *
 * Under `pnpm -r build` the environment points at pnpm's JS entry, so this
 * works on every platform without a shell.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} execPath
 * @returns {{ command: string, prefixArgs: string[] }}
 */
export function packageManagerInvocation(env = process.env, execPath = process.execPath) {
  const entry = env.npm_execpath?.trim()
  if (entry === undefined || entry === '') {
    throw new Error('run this script through pnpm so npm_execpath identifies its JS entry')
  }
  if (SHELL_SHIM.test(entry)) {
    throw new Error(`npm_execpath points at a shell shim (${entry}); run the JS entry instead`)
  }
  if (JS_ENTRY.test(entry)) return { command: execPath, prefixArgs: [entry] }
  return { command: entry, prefixArgs: [] }
}

/**
 * How to run npm from this process.
 *
 * The official Node installers and nvm-windows keep npm at
 * `<node dir>/node_modules/npm/bin/npm-cli.js`. POSIX keeps an executable
 * symlink on PATH, so the bare name is safe there; on Windows it is a `.cmd`
 * shim, so a missing entry point is a hard error rather than a bad spawn.
 */
export function npmInvocation(execPath = process.execPath, exists = existsSync, platform = process.platform) {
  const cli = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (exists(cli)) return { command: execPath, prefixArgs: [cli] }
  if (platform === 'win32') {
    throw new Error('npm entry point not found next to Node; use a standard Node.js installation')
  }
  return { command: 'npm', prefixArgs: [] }
}
