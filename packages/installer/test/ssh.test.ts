import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { parseTarget, runRemoteScript } from '../src/ssh.ts'

const skip = process.platform === 'win32'

function executable(path: string, body: string): string {
  writeFileSync(path, body, { mode: 0o755 })
  chmodSync(path, 0o755)
  return path
}

describe('remote bootstrap failures', { skip }, () => {
  it('keeps the stderr tail for an unknown exit code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bootstrap-tail-'))
    try {
      const ssh = executable(
        join(dir, 'ssh'),
        "#!/bin/sh\ncat > /dev/null\necho 'ssh: connection reset by peer' >&2\nexit 7\n",
      )
      await assert.rejects(
        runRemoteScript(parseTarget('example-host'), 'echo hi', {
          binary: ssh,
          strictHostKeyChecking: 'accept-new',
          timeoutMs: 5_000,
          verbose: false,
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.match(error.message, /remote bootstrap exited with 7/u)
          assert.match(error.message, /connection reset by peer/u)
          return true
        },
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
