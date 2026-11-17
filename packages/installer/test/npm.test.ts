import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'

import { npmInvocation } from '../src/npm.ts'

describe('npm invocation', () => {
  it('runs the npm entry point through this Node binary when present', () => {
    const execPath = join('/opt/node', 'bin', 'node')
    const cli = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    const invocation = npmInvocation(execPath, path => path === cli, 'linux')
    assert.equal(invocation.command, execPath)
    assert.deepEqual(invocation.prefixArgs, [cli])
  })

  it('falls back to the npm on PATH on POSIX', () => {
    const invocation = npmInvocation('/opt/node/bin/node', () => false, 'linux')
    assert.equal(invocation.command, 'npm')
    assert.deepEqual(invocation.prefixArgs, [])
  })

  it('fails instead of falling back to a Windows shell shim', () => {
    // A .cmd shim cannot be spawned without a shell; a missing entry point must
    // surface as an actionable error, not a broken spawn.
    assert.throws(
      () => npmInvocation('C:\\Program Files\\nodejs\\node.exe', () => false, 'win32'),
      /standard Node\.js installation/u,
    )
  })

  it('resolves the entry point beside a Windows node.exe', () => {
    const execPath = 'D:\\nodejs\\node.exe'
    const cli = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    const invocation = npmInvocation(execPath, path => path === cli, 'win32')
    assert.equal(invocation.command, 'D:\\nodejs\\node.exe')
    assert.deepEqual(invocation.prefixArgs, [cli])
  })
})
