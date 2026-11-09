import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

import { nodePathPrelude } from '../src/bootstrap.ts'

const skip = process.platform === 'win32' ? 'requires a POSIX shell' : false

function commandPath(name: string): string {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' })
  assert.equal(result.status, 0, `could not resolve ${name}: ${result.stderr}`)
  return result.stdout.trim()
}

describe('bootstrap node path prelude', () => {
  it('continues past a missing nvm installation', { skip }, () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-remote-prelude-'))
    try {
      const home = join(root, 'home')
      const bin = join(root, 'bin')
      mkdirSync(home)
      mkdirSync(bin)
      // Keep only the commands the prelude needs, and no node, so the
      // "node is not on PATH" branch is exercised deterministically.
      for (const name of ['ls', 'sort', 'tail']) {
        symlinkSync(commandPath(name), join(bin, name))
      }
      const script = `set -euo pipefail\n${nodePathPrelude()}\necho __prelude_completed__\n`
      const bash = commandPath('bash')
      const result = spawnSync(bash, ['-c', script], {
        encoding: 'utf8',
        env: { HOME: home, PATH: bin, SHELL: '' },
      })
      assert.equal(result.status, 0, result.error?.message ?? result.stderr)
      assert.match(result.stdout, /__prelude_completed__/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
