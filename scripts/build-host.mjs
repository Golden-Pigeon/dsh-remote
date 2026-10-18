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

const packageDir = process.cwd()
const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
const entry = process.env.DSH_REMOTE_HOST_ENTRY ?? 'src/index.ts'
const outfile = process.env.DSH_REMOTE_HOST_OUT ?? 'lib/index.js'
const isCli = process.env.DSH_REMOTE_CLI === '1'

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
