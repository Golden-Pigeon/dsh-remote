import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { parseTarget, runRemoteScript, scpArgs, sshArgs } from '../src/ssh.ts'

const skip = process.platform === 'win32'

function executable(path: string, body: string): string {
  writeFileSync(path, body, { mode: 0o755 })
  chmodSync(path, 0o755)
  return path
}

describe('extra ssh options', () => {
  it('prefixes ssh and scp argv without losing the destination port', () => {
    const parsed = parseTarget('example-host:2222')
    const target = { ...parsed, sshArgs: ['-4', '-o', 'ConnectTimeout=9'] }
    const ssh = sshArgs(target, { timeoutMs: 5_000, strictHostKeyChecking: 'accept-new' })
    assert.deepEqual(ssh.slice(0, 3), ['-4', '-o', 'ConnectTimeout=9'])
    assert.deepEqual(ssh.slice(-2), ['-p', '2222'])
    const scp = scpArgs(target, { strictHostKeyChecking: 'accept-new' }, '/tmp/local', '/tmp/remote')
    assert.deepEqual(scp.slice(0, 3), ['-4', '-o', 'ConnectTimeout=9'])
    assert.ok(scp.includes('-P'))
    assert.ok(scp.includes('2222'))
    assert.equal(scp.at(-1), 'example-host:/tmp/remote')
  })
})

describe('scp option translation', () => {
  it('maps ssh-only options and drops forwarding/escape options', () => {
    const target = {
      ...parseTarget('example-host'),
      sshArgs: ['-B', 'eth0', '-b', '10.0.0.2', '-m', 'hmac-sha2-256', '-L', '8080:host:80', '-e', 'none', '-X', '-K', '-o', 'ConnectTimeout=9', '-4'],
    }
    const args = scpArgs(target, { strictHostKeyChecking: 'accept-new' }, '/tmp/local', '/tmp/remote')
    assert.deepEqual(args.slice(0, 9), [
      '-o', 'BindInterface=eth0',
      '-o', 'BindAddress=10.0.0.2',
      '-o', 'MACs=hmac-sha2-256',
      '-o', 'ConnectTimeout=9',
      '-4',
    ])
    assert.equal(args.includes('-L'), false)
    assert.equal(args.includes('-e'), false)
    assert.equal(args.includes('-B'), false)
    assert.equal(args.includes('-X'), false)
    assert.equal(args.includes('-K'), false)
  })
})

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
