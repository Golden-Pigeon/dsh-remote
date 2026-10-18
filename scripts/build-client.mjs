/**
 * Build one browser client entry into the module-loader closure-factory
 * artifact DSH expects at `/plugins/<pkg>/client.js`.
 *
 * The artifact registers itself with `window.__ModuleLoader__` and resolves
 * every shared platform module through the injected `require` — the same
 * protocol the official `clientBundle` tsdown preset emits. React, Cordis,
 * Zod, and DSH client libraries are peers supplied by the shell, never
 * bundled.
 */
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const packageDir = process.cwd()
const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
const packageName = manifest.name
const entry = 'src/client/index.tsx'
const outfile = 'lib/client.js'

const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const banner = [
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(packageName)},`,
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
].join('\n')

const footer = [
  '    return module.exports;',
  '  },',
  '});',
].join('\n')

await build({
  absWorkingDir: packageDir,
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  loader: { '.css': 'text' },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  banner: { js: banner },
  footer: { js: footer },
  external: [
    ...PLATFORM_MODULES,
    '@deepseek-ai/*',
    'react/*',
    'react-dom/*',
  ],
})

process.stdout.write(`built ${packageName} -> ${join(packageDir, outfile)}\n`)
