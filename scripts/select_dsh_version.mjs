/** Pin every installed DSH dependency and peer to one CI compatibility target. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const version = process.argv[2]
if (version === undefined || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
  throw new Error('Usage: node scripts/select_dsh_version.mjs <exact-dsh-version>')
}
const cwd = fileURLToPath(new URL('..', import.meta.url))
const installed = JSON.parse(execFileSync('pnpm', ['list', '--recursive', '--depth', 'Infinity', '--json'], { cwd, encoding: 'utf8' }))
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
execFileSync('pnpm', ['config', 'set', '--location=project', '--json', 'overrides', JSON.stringify(overrides)], { cwd, stdio: 'inherit' })
console.log(`Pinned ${names.size} DSH packages and peers to ${version}`)
