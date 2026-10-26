/**
 * Print the CHANGELOG section for the current plugin version.
 *
 * The Release workflow writes this output to the GitHub Release body, so every
 * tag carries the same user-facing summary as CHANGELOG.md. Fails loudly when
 * the version has no section, instead of publishing an empty release.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'packages', 'local-plugin', 'package.json'), 'utf8'))
const version = manifest.version
const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/u)
const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const heading = new RegExp(`^##\\s+\\[?${escaped}\\]?\\s*$`, 'u')
const start = lines.findIndex(line => heading.test(line))
if (start === -1) {
  console.error(`release-notes: CHANGELOG.md has no "## ${version}" section`)
  process.exit(1)
}
let end = lines.length
for (let index = start + 1; index < lines.length; index += 1) {
  if (lines[index]?.startsWith('## ')) {
    end = index
    break
  }
}
const body = lines.slice(start + 1, end).join('\n').trim()
if (body === '') {
  console.error(`release-notes: CHANGELOG.md section for ${version} is empty`)
  process.exit(1)
}
process.stdout.write(`${body}\n`)
