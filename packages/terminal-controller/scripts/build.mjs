/**
 * Build the fork's browser entry from the pinned stock client implementation.
 *
 * The stock client is a self-registering DSH module-loader artifact, not an ES
 * module. Bundling it as an external require fails when the stock row is
 * disabled (the module table has no factory). This script copies its factory
 * body into our own loader artifact and replaces only the apply function with
 * the Session-routing construction.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const stockPackage = require.resolve('@deepseek-ai/dsh-api-terminal-controller/package.json')
const stockPath = join(dirname(stockPackage), 'lib', 'client.js')
const stock = await readFile(stockPath, 'utf8')
const startMarker = 'factory: (require) => {'
const start = stock.indexOf(startMarker)
if (start < 0) throw new Error('stock client factory marker not found')
const endMarker = '\n\t}\n});'
const end = stock.lastIndexOf(endMarker)
if (end < 0) throw new Error('stock client factory end marker not found')
const body = stock.slice(start + startMarker.length, end)

const routing = await readFile(join(here, '..', 'src', 'client', 'routing.js'), 'utf8')
const applyPattern = /function apply\(ctx\) \{\n\s*new ClientTerminals\(ctx, ctx\.remote\.terminal\);\n\s*\}/
if (!applyPattern.test(body)) throw new Error('stock ClientTerminals apply function not found')
const replaced = body.replace(applyPattern, `function apply(ctx) {\n\t\t\tapplyRouted(ctx);\n\t\t}\n${routing}`)

await mkdir(join(here, '..', 'lib'), { recursive: true })
const output = `window.__ModuleLoader__.load({\n\tid: "dsh-remote-terminal-controller",\n\tfactory: (require) => {${replaced}\n\t}\n});\n`
await writeFile(join(here, '..', 'lib', 'client.js'), output)
await writeFile(join(here, '..', 'lib', 'index.js'), `// Host half: keep the stock TerminalController implementation unchanged. The
// client half is what routes local versus mirrored Sessions.
export { TerminalController as default, TerminalController } from '@deepseek-ai/dsh-api-terminal-controller'\n`)
process.stdout.write('built dsh-remote-terminal-controller client\n')
