import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'

import { npmInvocation, packageManagerInvocation } from './package-manager.mjs'

describe('package manager invocation', () => {
  it('runs the pnpm JS entry through this Node binary', () => {
    const entry = join('/opt/pnpm', 'bin', 'pnpm.cjs')
    const invocation = packageManagerInvocation({ npm_execpath: entry }, '/opt/node/bin/node')
    assert.equal(invocation.command, '/opt/node/bin/node')
    assert.deepEqual(invocation.prefixArgs, [entry])
  })

  it('runs a native package-manager entry directly', () => {
    const entry = join('/opt/pnpm', 'pnpm.exe')
    const invocation = packageManagerInvocation({ npm_execpath: entry }, '/opt/node/bin/node')
    assert.equal(invocation.command, entry)
    assert.deepEqual(invocation.prefixArgs, [])
  })

  it('rejects a .cmd shim from npm_execpath', () => {
    assert.throws(
      () => packageManagerInvocation({ npm_execpath: 'C:\\nodejs\\pnpm.cmd' }, 'C:\\nodejs\\node.exe'),
      /shell shim/u,
    )
  })

  it('rejects a missing npm_execpath', () => {
    assert.throws(() => packageManagerInvocation({}, '/opt/node/bin/node'), /npm_execpath/u)
  })

  it('resolves npm next to Node', () => {
    const execPath = join('/opt/node', 'bin', 'node')
    const cli = join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    const invocation = npmInvocation(execPath, path => path === cli, 'linux')
    assert.equal(invocation.command, execPath)
    assert.deepEqual(invocation.prefixArgs, [cli])
  })

  it('does not fall back to a Windows shim', () => {
    assert.throws(
      () => npmInvocation('C:\\nodejs\\node.exe', () => false, 'win32'),
      /standard Node\.js installation/u,
    )
  })
})
