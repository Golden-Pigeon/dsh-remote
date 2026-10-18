/**
 * Build the installable local-plugin tarball.
 *
 * The public package is a single DSH bundle: the terminal-controller fork is
 * copied into its bundled `node_modules` and declared as a bundled dependency.
 * This keeps the DSH plugin-page install to one package name while allowing
 * the terminal fork to remain a separately maintainable workspace package.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const pluginDir = join(root, 'packages', 'local-plugin')
const terminalDir = join(root, 'packages', 'terminal-controller')
const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
const terminalManifest = JSON.parse(readFileSync(join(terminalDir, 'package.json'), 'utf8'))
const version = manifest.version
const target = join(pluginDir, `dsh-remote-local-plugin-${version}.tgz`)

for (const required of [
  join(pluginDir, 'lib', 'index.js'),
  join(pluginDir, 'assets'),
  join(terminalDir, 'lib', 'index.js'),
  join(terminalDir, 'lib', 'client.js'),
]) {
  if (!existsSync(required)) throw new Error(`release-plugin: missing build output ${required}; run pnpm -r build first`)
}

const staging = mkdtempSync(join(tmpdir(), 'dsh-remote-release-'))
try {
  for (const entry of ['lib', 'assets', 'cordis.patch.yml', 'README.md']) {
    cpSync(join(pluginDir, entry), join(staging, entry), { recursive: true })
  }
  cpSync(join(root, 'LICENSE'), join(staging, 'LICENSE'))

  const terminalTarget = join(staging, 'node_modules', 'dsh-remote-terminal-controller')
  for (const entry of ['lib', 'cordis.patch.yml', 'README.md', 'package.json']) {
    cpSync(join(terminalDir, entry), join(terminalTarget, entry), { recursive: true })
  }

  const published = {
    ...manifest,
    files: ['lib', 'assets', 'cordis.patch.yml', 'README.md', 'LICENSE'],
    dependencies: {
      ...manifest.dependencies,
      'dsh-remote-terminal-controller': terminalManifest.version,
    },
    bundledDependencies: ['dsh-remote-terminal-controller'],
    scripts: {},
    devDependencies: undefined,
  }
  writeFileSync(join(staging, 'package.json'), `${JSON.stringify(published, null, 2)}\n`)

  const packOutput = execFileSync('npm', ['pack', '--silent', '--pack-destination', staging], {
    cwd: staging,
    encoding: 'utf8',
  }).trim().split('\n').at(-1)
  if (packOutput === undefined || packOutput === '') throw new Error('release-plugin: npm pack produced no filename')
  const packed = join(staging, packOutput)
  if (!existsSync(packed)) throw new Error(`release-plugin: npm pack did not create ${packed}`)
  renameSync(packed, target)
  process.stdout.write(`${target}\n`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
