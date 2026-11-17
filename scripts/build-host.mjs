/**
 * Bundle one host entry into a self-contained ESM file.
 *
 * DSH host plugins run inside the profile's Node process. The only imports
 * that may remain external are DSH/Cordis peers, which the Loader resolves
 * from the running Harness installation. The plugin's own workspace packages
 * (@dsh-remote/protocol) are bundled so a packed tarball is installable
 * without publishing those internal packages.
 */
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Read `--name value` and `--flag` pairs.
 *
 * npm scripts cannot use POSIX `VAR=1 cmd` prefixes on Windows, so the same
 * settings are available as arguments. Environment variables still work and
 * lose to an explicit argument.
 */
function parseFlags(argv) {
  const flags = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const name = arg.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      flags.set(name, true)
    } else {
      flags.set(name, next)
      index += 1
    }
  }
  return flags
}

const flags = parseFlags(process.argv.slice(2))
for (const name of ['entry', 'out']) {
  if (flags.get(name) === true) throw new Error(`--${name} requires a value`)
}
const packageDir = process.cwd()
const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
const entry = flags.get('entry') ?? process.env.DSH_REMOTE_HOST_ENTRY ?? 'src/index.ts'
const outfile = flags.get('out') ?? process.env.DSH_REMOTE_HOST_OUT ?? 'lib/index.js'
const isCli = flags.has('cli') || process.env.DSH_REMOTE_CLI === '1'

await build({
  absWorkingDir: packageDir,
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  banner: {
    js: `${isCli ? '#!/usr/bin/env node\n' : ''}/* ${manifest.name}@${manifest.version} — bundled host entry */`,
  },
  external: [
    '@deepseek-ai/*',
    'node:*',
  ],
})

process.stdout.write(`built ${manifest.name} -> ${join(packageDir, outfile)}\n`)
