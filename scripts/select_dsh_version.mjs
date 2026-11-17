/** Pin every installed DSH dependency and peer to one CI compatibility target. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { packageManagerInvocation } from './package-manager.mjs'

const version = process.argv[2]
if (version === undefined || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
  throw new Error('Usage: node scripts/select_dsh_version.mjs <exact-dsh-version>')
}
const cwd = fileURLToPath(new URL('..', import.meta.url))
function pnpm() {
  try {
    return packageManagerInvocation()
  } catch {
    // Running this developer tool directly is fine on POSIX, where pnpm on
    // PATH is a real executable. On Windows it is a .cmd shim, so require the
    // pnpm-launched environment instead of a broken spawn.
    if (process.platform !== 'win32') return { command: 'pnpm', prefixArgs: [] }
    throw new Error('run this script through pnpm so npm_execpath provides a JS entry point')
  }
}
const pnpmCmd = pnpm()
const installed = JSON.parse(execFileSync(pnpmCmd.command, [...pnpmCmd.prefixArgs, 'list', '--recursive', '--depth', 'Infinity', '--json'], { cwd, encoding: 'utf8' }))
const names = new Set()
function visit(value) {
  if (value === null || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) {
    if (/^@deepseek-ai\/dsh-[a-z0-9-]+$/.test(key)) names.add(key)
    visit(entry)
  }
}
visit(installed)
if (names.size === 0) throw new Error('Install the frozen workspace before selecting a compatibility target')
const overrides = Object.fromEntries([...names].sort().map(name => [name, version]))
// Cordis must match the DSH family; the supported 0.2.2 line uses 4.1.0.
overrides['@deepseek-ai/cordis'] = '4.1.0'
execFileSync(pnpmCmd.command, [...pnpmCmd.prefixArgs, 'config', 'set', '--location=project', '--json', 'overrides', JSON.stringify(overrides)], { cwd, stdio: 'inherit' })
console.log(`Pinned ${names.size} DSH packages and peers to ${version}`)
