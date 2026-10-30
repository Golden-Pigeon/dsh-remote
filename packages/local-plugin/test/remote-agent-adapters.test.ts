import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { installRemoteWorkspaceFiles } from '../src/remote/files.ts'
import { listRemoteDirectories } from '../src/remote/directory.ts'

describe('remote workspace files over the agent', () => {
  it('routes read/stat/list/bytes/watch through the agent when capabilities exist', async () => {
    const service = {
      read: async () => { throw new Error('local read') },
      readBytes: async () => { throw new Error('local bytes') },
      stat: async () => { throw new Error('local stat') },
      list: async () => { throw new Error('local list') },
      changes: async function* () { yield { kind: 'ready' as const } },
    }
    const calls: string[] = []
    const client = {
      async fileRead(path: string) { calls.push(`read:${path}`); return { absolutePath: path, version: 'v', bytes: 1, offset: 1, lines: 1, text: 'x', eof: true } },
      async fileBytes(path: string) { calls.push(`bytes:${path}`); return { absolutePath: path, version: 'v', bytes: 1, offset: 0, data: 'eA==', eof: true } },
      async fileStat(path: string) { calls.push(`stat:${path}`); return { absolutePath: path, version: 'v', bytes: 1 } },
      async fileList(path: string) { calls.push(`list:${path}`); return { path, entries: [{ name: 'a', type: 'file' as const, size: 1 }], truncated: false } },
      async *followFileChanges(path: string) {
        yield { kind: 'ready' as const }
        yield { kind: 'change' as const, change: { absolutePath: path, version: 'v2' } }
      },
    }
    const hosts = {
      supportsAgent: () => true,
      agentFor: () => client,
    }
    const mirrors = { remoteFileContext: () => ({ hostId: 'h', remoteRoot: '/remote' }) }
    const ctx = { get: () => service }
    installRemoteWorkspaceFiles(ctx as never, mirrors as never, hosts as never)
    const scope = { workspaceRoot: '/anchor' }
    assert.equal((await service.read(scope, 'a.txt', { offset: 1, limit: 2 }, new AbortController().signal)).absolutePath, '/anchor/a.txt')
    assert.equal((await service.readBytes(scope, 'a.txt', {}, new AbortController().signal)).data.toString(), 'x')
    assert.equal((await service.stat(scope, 'a.txt', new AbortController().signal)).absolutePath, '/anchor/a.txt')
    assert.equal((await service.list(scope, '', new AbortController().signal)).path, '')
    assert.deepEqual(calls, ['read:/remote/a.txt', 'bytes:/remote/a.txt', 'stat:/remote/a.txt', 'list:/remote'])
    const controller = new AbortController()
    const frames = []
    for await (const frame of service.changes(scope, 'a.txt', controller.signal)) {
      frames.push(frame)
      if (frames.length === 2) {
        controller.abort()
        break
      }
    }
    assert.deepEqual(frames, [
      { kind: 'ready' },
      { kind: 'change', change: { absolutePath: '/anchor/a.txt', version: 'v2' } },
    ])
  })
})

describe('remote directory picker over the agent', () => {
  it('uses the agent listing when directory.list is advertised', async () => {
    const hosts = {
      supportsAgent: () => true,
      agentFor: () => ({ listDirectories: async (path: string) => ({ path, parent: '/', entries: [{ name: 'p', path: '/p' }], truncated: false }) }),
    }
    const listing = await listRemoteDirectories(hosts as never, 'h', '/p')
    assert.deepEqual(listing.entries, [{ name: 'p', path: '/p' }])
  })
})

import { RemoteTerminals } from '../src/remote/terminal.ts'

describe('remote terminal over the agent', () => {
  it('creates, lists, inputs, attaches, and closes through the agent client', async () => {
    const calls: string[] = []
    const info = {
      id: 't1',
      title: 'T',
      shell: { path: '/bin/bash', name: 'bash', args: [] },
      cwd: '/remote/work',
      cols: 80,
      rows: 24,
      state: 'running' as const,
      exitCode: null,
    }
    const client = {
      async createTerminal(request: { id?: string }) { calls.push(`create:${request.id ?? ''}`); return info },
      async listTerminals() { return [info] },
      async terminalInput(id: string, input: { type: string }) { calls.push(`input:${id}:${input.type}`) },
      async renameTerminal(id: string, title: string) { calls.push(`rename:${id}:${title}`) },
      async closeTerminal(id: string) { calls.push(`close:${id}`) },
      async *attachTerminal() {
        yield { type: 'snapshot' as const, sequence: 0, screen: '', info, writable: true }
        yield { type: 'output' as const, sequence: 1, data: 'hello' }
      },
    }
    const hosts = {
      supportsAgent: () => true,
      agentFor: () => client,
    }
    const sessions = { get: () => ({ header: { cwd: '/anchor/work' } }) }
    const ctx = { get: (name: string) => name === 'sessions' ? sessions : undefined }
    const mirrors = { remoteFileContext: () => ({ hostId: 'h', remoteRoot: '/remote/work' }) }
    const terminals = new RemoteTerminals(ctx as never, hosts as never, mirrors as never)
    assert.equal((await terminals.create('s1', { id: 't1' })).id, 't1')
    assert.equal((await terminals.list('s1'))[0]?.id, 't1')
    await terminals.input('t1', { type: 'write', sequence: 1, data: 'echo hi\n' })
    await terminals.rename('t1', 'new')
    const frames = []
    for await (const frame of terminals.attach('t1', new AbortController().signal)) frames.push(frame.type)
    assert.deepEqual(frames, ['snapshot', 'output'])
    await terminals.close('t1')
    assert.deepEqual(calls, ['create:t1', 'input:t1:write', 'rename:t1:new', 'close:t1'])
  })
})
