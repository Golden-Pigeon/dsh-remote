import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { parseTarget, scpArgs, uploadFile, type ScpOptions } from '../src/ssh.ts'

const skip = process.platform === 'win32'

function executable(path: string, body: string): string {
  writeFileSync(path, body, { mode: 0o755 })
  chmodSync(path, 0o755)
  return path
}

function options(binary: string, timeoutMs = 120_000): ScpOptions {
  return { binary, strictHostKeyChecking: 'accept-new', verbose: false, timeoutMs }
}

describe('scp upload', { skip }, () => {
  it('builds a non-interactive argv with a bounded connect phase', () => {
    const args = scpArgs(parseTarget('alice@example-host:2222'), options('scp', 30_000), '/tmp/a.tgz', '/tmp/b.tgz')
    assert.ok(args.includes('BatchMode=yes'))
    assert.ok(args.includes('ConnectTimeout=30'))
    assert.ok(args.includes('-P'))
  })

  it('resolves when scp succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-upload-ok-'))
    try {
      const scp = executable(join(dir, 'scp'), '#!/bin/sh\nexit 0\n')
      await uploadFile('/tmp/a.tgz', '/tmp/b.tgz', parseTarget('alice@example-host'), options(scp))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports the last stderr line when scp fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-upload-fail-'))
    try {
      const scp = executable(join(dir, 'scp'), "#!/bin/sh\necho 'debug line' >&2\necho 'scp: permission denied' >&2\nexit 1\n")
      await assert.rejects(
        uploadFile('/tmp/a.tgz', '/tmp/b.tgz', parseTarget('alice@example-host'), options(scp)),
        /scp failed with 1: scp: permission denied/u,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('times out with the last stderr line and kills the child', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-upload-timeout-'))
    try {
      const scp = executable(join(dir, 'scp'), "#!/bin/sh\necho 'scp: stalled upload' >&2\nexec sleep 5\n")
      await assert.rejects(
        uploadFile('/tmp/a.tgz', '/tmp/b.tgz', parseTarget('alice@example-host'), options(scp, 1_000)),
        /scp timed out after 1000ms: scp: stalled upload/u,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('kills the scp process tree on timeout', { skip: process.platform === 'win32' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-upload-tree-'))
    const ticks = join(dir, 'ticks')
    const pidPath = join(dir, 'child.pid')
    try {
      const scp = executable(
        join(dir, 'scp'),
        `#!/bin/sh
(while true; do echo tick >> '${ticks}'; sleep 0.05; done) &
echo $! > '${pidPath}'
wait
`,
      )
      await assert.rejects(
        uploadFile('/tmp/a.tgz', '/tmp/b.tgz', parseTarget('alice@example-host'), options(scp, 1_000)),
        /scp timed out after 1000ms/u,
      )
      // Give the process group kill time to land, then make sure the child
      // stopped writing. A surviving child would keep appending ticks.
      await new Promise(resolve => setTimeout(resolve, 300))
      const first = readFileSync(ticks).length
      assert.ok(first > 0, 'the scp child never started')
      await new Promise(resolve => setTimeout(resolve, 300))
      assert.equal(readFileSync(ticks).length, first, 'the scp child kept running after the timeout')
    } finally {
      try {
        process.kill(Number(readFileSync(pidPath, 'utf8').trim()), 'SIGKILL')
      } catch {
        // The child is already gone, or the fixture failed before writing it.
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the final stderr line after a large output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-upload-large-stderr-'))
    try {
      const scp = executable(
        join(dir, 'scp'),
        "#!/bin/sh\nhead -c 100000 /dev/zero | tr '\\0' 'x' >&2\nprintf '\\n' >&2\necho 'scp: final failure' >&2\nexit 1\n",
      )
      await assert.rejects(
        uploadFile('/tmp/a.tgz', '/tmp/b.tgz', parseTarget('alice@example-host'), options(scp)),
        /scp failed with 1: scp: final failure/u,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a missing scp binary', async () => {
    await assert.rejects(
      uploadFile('/tmp/a.tgz', '/tmp/b.tgz', parseTarget('alice@example-host'), options(join(tmpdir(), 'dsh-no-such-scp'))),
      /ENOENT/u,
    )
  })
})
