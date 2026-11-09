import assert from 'node:assert/strict'
import { posix, win32 } from 'node:path'
import { describe, it } from 'node:test'

import { resolveRemoteFileTarget } from '../src/remote/remote-path.ts'

const windowsAnchor = String.raw`C:\Users\alice\.dsh\remote\anchors\h\ungrouped\home-ubuntu`
const remoteRoot = '/home/ubuntu'

function windows(path: string) {
  return {
    hostId: 'host-1',
    workspaceRoot: windowsAnchor,
    remoteRoot,
    path,
    localPath: win32,
    remotePath: posix,
  }
}

describe('remote file target paths', () => {
  it('keeps a remote absolute workspace path on the POSIX side', () => {
    assert.deepEqual(resolveRemoteFileTarget(windows('/home/ubuntu')), {
      hostId: 'host-1',
      localPath: windowsAnchor,
      remotePath: '/home/ubuntu',
      relativePath: '',
      workspaceRoot: windowsAnchor,
    })
  })

  it('maps a remote child path to the local Windows anchor', () => {
    const target = resolveRemoteFileTarget(windows('/home/ubuntu/foo.txt'))
    assert.equal(target.remotePath, '/home/ubuntu/foo.txt')
    assert.equal(target.localPath, String.raw`C:\Users\alice\.dsh\remote\anchors\h\ungrouped\home-ubuntu\foo.txt`)
    assert.equal(target.relativePath, 'foo.txt')
  })

  it('maps a relative path to both namespaces', () => {
    const target = resolveRemoteFileTarget(windows('foo.txt'))
    assert.equal(target.remotePath, '/home/ubuntu/foo.txt')
    assert.equal(target.localPath, String.raw`C:\Users\alice\.dsh\remote\anchors\h\ungrouped\home-ubuntu\foo.txt`)
    assert.equal(target.relativePath, 'foo.txt')
  })

  it('maps the workspace root itself', () => {
    const target = resolveRemoteFileTarget(windows('.'))
    assert.equal(target.remotePath, '/home/ubuntu')
    assert.equal(target.localPath, windowsAnchor)
    assert.equal(target.relativePath, '')
  })

  it('converts a Windows relative path to a POSIX remote path', () => {
    const target = resolveRemoteFileTarget(windows(String.raw`C:\Users\alice\.dsh\remote\anchors\h\ungrouped\home-ubuntu\sub\file.txt`))
    assert.equal(target.remotePath, '/home/ubuntu/sub/file.txt')
    assert.equal(target.relativePath, 'sub/file.txt')
    assert.equal(target.localPath, String.raw`C:\Users\alice\.dsh\remote\anchors\h\ungrouped\home-ubuntu\sub\file.txt`)
  })

  it('keeps POSIX local anchors working', () => {
    const target = resolveRemoteFileTarget({
      hostId: 'host-1',
      workspaceRoot: '/Users/alice/anchors',
      remoteRoot,
      path: 'sub/file',
      localPath: posix,
      remotePath: posix,
    })
    assert.equal(target.remotePath, '/home/ubuntu/sub/file')
    assert.equal(target.localPath, '/Users/alice/anchors/sub/file')
    assert.equal(target.relativePath, 'sub/file')
  })

  it('passes a remote absolute path outside the workspace through', () => {
    const target = resolveRemoteFileTarget(windows('/etc/hosts'))
    assert.equal(target.remotePath, '/etc/hosts')
    assert.equal(target.localPath, '/etc/hosts')
    assert.equal(target.relativePath, '/etc/hosts')
  })

  it('does not reject a local name that begins with two dots', () => {
    const target = resolveRemoteFileTarget(windows('..foo'))
    assert.equal(target.remotePath, '/home/ubuntu/..foo')
    assert.equal(target.relativePath, '..foo')
  })

  it('rejects a relative path that escapes the anchor', () => {
    assert.throws(
      () => resolveRemoteFileTarget(windows('../outside')),
      (error: unknown) => (error as { code?: string }).code === 'workspace-file/not-found',
    )
  })
})
