/**
 * Build the fork's browser entry from the pinned stock client implementation.
 *
 * The stock client is a self-registering DSH module-loader artifact, not an ES
 * module. Bundling it as an external require fails when the stock row is
 * disabled (the module table has no factory). This script rewrites the stock
 * artifact in place: it swaps the module id and replaces only the apply
 * function with the Session-routing construction.
 *
 * The transform targets the 0.2.2-rc.2 artifact shape and refuses older stock
 * clients, which lack the watch/roster face the current UI calls.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const STOCK_ID = '@deepseek-ai/dsh-api-terminal-controller'
const FORK_ID = 'dsh-remote-terminal-controller'
const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const stockPackage = require.resolve(STOCK_ID + '/package.json')
const stockPath = join(dirname(stockPackage), 'lib', 'client.js')
const stock = await readFile(stockPath, 'utf8')

// The rc.2 loader artifact is minified to one line: id:`...`,factory:require=>{...}
const idPattern = new RegExp('id:\\s*`' + STOCK_ID + '`')
if (!idPattern.test(stock)) throw new Error('stock client module id marker not found')
const applyPattern = /function apply\(ctx\)\s*\{\s*new ClientTerminals\(ctx,\s*ctx\.remote\.terminal\)\s*\}/
if (!applyPattern.test(stock)) throw new Error('stock ClientTerminals apply function not found')
for (const method of ['watch(', 'boundTerminal(', 'isRepresented(']) {
  if (!stock.includes(method)) throw new Error('stock client does not expose the 0.2.2-rc.2 terminal face (' + method + ')')
}

const routing = await readFile(join(here, '..', 'src', 'client', 'routing.js'), 'utf8')
const output = stock
  .replace(idPattern, () => 'id:`' + FORK_ID + '`')
  .replace(applyPattern, () => 'function apply(ctx){applyRouted(ctx)}\n' + routing)
  .replace(/\n?\/\/# sourceMappingURL=client\.js\.map\s*$/u, '\n')

await mkdir(join(here, '..', 'lib'), { recursive: true })
await writeFile(join(here, '..', 'lib', 'client.js'), output)
await writeFile(join(here, '..', 'lib', 'index.js'), `// Host half: keep the stock TerminalController implementation unchanged. The
// client half is what routes local versus mirrored Sessions.
export { TerminalController as default, TerminalController } from '${STOCK_ID}'\n`)
// The stock row is disabled, so this package must own the host Typert face or
// the gateway loses every terminal endpoint. Re-own the stock manifest because
// the loader requires TYPERT.package to equal the exporting package name.
await writeFile(join(here, '..', 'lib', 'typert.host.js'), `import { TYPERT as STOCK } from '${STOCK_ID}/typert'

export const TYPERT = { ...STOCK, package: '${FORK_ID}' }
`)
await writeFile(join(here, '..', 'lib', 'typert.host.d.ts'), 'export declare const TYPERT: unknown\n')
process.stdout.write('built dsh-remote-terminal-controller client\n')
