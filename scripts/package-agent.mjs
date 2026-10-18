/**
 * Pack the built remote agent into the local plugin's assets directory.
 *
 * The local plugin ships this tarball so it can bootstrap a remote host
 * without a separate installer run. The remote agent package must already be
 * built; `pnpm -r build` orders it before the local plugin through the
 * workspace devDependency.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const agentDir = join(root, 'packages', 'remote-agent')
const assetsDir = join(root, 'packages', 'local-plugin', 'assets')

if (!existsSync(join(agentDir, 'lib', 'index.js'))) {
  throw new Error('dsh-remote-agent is not built; run `pnpm --filter dsh-remote-agent build` first')
}

rmSync(assetsDir, { recursive: true, force: true })
mkdirSync(assetsDir, { recursive: true })
execFileSync('pnpm', ['pack', '--pack-destination', assetsDir], {
  cwd: agentDir,
  stdio: 'inherit',
})
process.stdout.write(`packed remote agent into ${assetsDir}\n`)
