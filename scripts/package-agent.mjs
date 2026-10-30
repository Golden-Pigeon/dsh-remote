/**
 * Pack the built remote agent into the local plugin's assets directory.
 *
 * The local plugin ships this tarball so it can bootstrap a remote host
 * without a separate installer run. The remote agent package must already be
 * built; `pnpm -r build` orders it before the local plugin through the
 * workspace devDependency.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const agentDir = join(root, 'packages', 'remote-agent')
const assetsDir = join(root, 'packages', 'local-plugin', 'assets')
const manifest = JSON.parse(readFileSync(join(agentDir, 'package.json'), 'utf8'))
const version = manifest.version

if (!existsSync(join(agentDir, 'lib', 'index.js'))) {
  throw new Error('dsh-remote-agent is not built; run `pnpm --filter @goldenpigeon/dsh-remote-agent build` first')
}
if (!readFileSync(join(agentDir, 'lib', 'index.js'), 'utf8').includes(version)) {
  throw new Error(`packaged agent build does not contain its manifest version ${version}; rebuild the agent`)
}

rmSync(assetsDir, { recursive: true, force: true })
mkdirSync(assetsDir, { recursive: true })
execFileSync('pnpm', ['pack', '--pack-destination', assetsDir], {
  cwd: agentDir,
  stdio: 'inherit',
})
const tarballs = readdirSync(assetsDir).filter(name => name.endsWith('.tgz'))
if (tarballs.length !== 1) throw new Error(`expected one packed agent tarball, found ${tarballs.length}`)
const tarball = join(assetsDir, tarballs[0])
const packedManifest = JSON.parse(execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }))
if (packedManifest.version !== version) {
  throw new Error(`packed agent version ${packedManifest.version} does not match manifest ${version}`)
}
const packedIndex = execFileSync('tar', ['-xOzf', tarball, 'package/lib/index.js'], { encoding: 'utf8' })
if (!packedIndex.includes(version)) throw new Error(`packed agent bundle does not contain ${version}`)
process.stdout.write(`packed remote agent ${version} into ${assetsDir}\n`)
