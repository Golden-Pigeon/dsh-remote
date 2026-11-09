import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { installRemoteTerminalController } from '../src/remote/terminal-controller.ts'

function fakeController() {
  const calls: string[] = []
  const info = {
    id: 't1', title: 'T', shell: { path: '/bin/bash', name: 'bash', args: [] },
    cwd: '/local', cols: 80, rows: 24, state: 'running' as const, exitCode: null,
  }
  const controller: any = {
    ctx: {},
    environment(agent: any) {
      calls.push(`local:environment:${agent.id}`)
      return { cwd: '/local', maxInputBytes: 1, maxBufferedBytes: 1, maxCols: 80, maxRows: 24, scrollback: 0 }
    },
    shells() { calls.push('local:shells'); return Promise.resolve([]) },
    list() { calls.push('local:list'); return [] },
    create() { calls.push('local:create'); return Promise.resolve(info) },
    retain() { calls.push('local:retain'); return (async function* () { yield { type: 'retained' } })() },
    attach() { calls.push('local:attach'); return (async function* () { yield { type: 'state', sequence: 0, info, writable: true } })() },
    rename() { calls.push('local:rename') },
    close() { calls.push('local:close'); return Promise.resolve() },
  }
  return { controller, calls, info }
}

function fakeTerminals() {
  const calls: string[] = []
  const inputs: any[] = []
  const info = {
    id: 't1', title: 'T', shell: { path: '/bin/bash', name: 'Remote Bash', args: [] },
    cwd: '/remote', cols: 80, rows: 24, state: 'running' as const, exitCode: null,
  }
  const terminals: any = {
    isMirrored: (id: string) => id === 'mirror',
    environment: (id: string) => {
      calls.push(`remote:environment:${id}`)
      return { cwd: '/remote', maxInputBytes: 1, maxBufferedBytes: 1, maxCols: 80, maxRows: 24, scrollback: 0 }
    },
    shells: () => { calls.push('remote:shells'); return [{ path: '/bin/bash', name: 'Remote Bash', args: [] }] },
    list: async (id: string) => { calls.push(`remote:list:${id}`); return [info] },
    create: async (id: string, request: any) => { calls.push(`remote:create:${id}:${request.id}`); return info },
    input: async (id: string, input: any) => { calls.push(`remote:input:${id}`); inputs.push(input) },
    rename: async (id: string, title: string) => { calls.push(`remote:rename:${id}:${title}`) },
    close: async (id: string) => { calls.push(`remote:close:${id}`) },
    attach: async function* (id: string) {
      calls.push(`remote:attach:${id}`)
      yield { type: 'state', sequence: 0, info, writable: true }
    },
  }
  return { terminals, calls, inputs, info }
}

describe('gateway terminal routing', () => {
  it('routes mirrored Sessions to the remote terminal manager and keeps local Sessions local', async () => {
    const { controller, calls: localCalls } = fakeController()
    const { terminals, calls: remoteCalls, inputs, info } = fakeTerminals()
    const warnings: string[] = []
    const ctx = { logger: { warn: (...args: unknown[]) => { warnings.push(args.join(' ')) } } }
    const restore = installRemoteTerminalController(ctx as never, controller as never, terminals as never)
    const signal = new AbortController().signal
    const mirror = { id: 'mirror' }
    const local = { id: 'local' }

    assert.equal(controller.environment(mirror, signal).cwd, '/remote')
    assert.deepEqual(await controller.shells(mirror, signal), [{ path: '/bin/bash', name: 'Remote Bash', args: [] }])
    assert.deepEqual(await controller.list('mirror'), [info])
    assert.deepEqual(await controller.create(mirror, { id: 't1', cols: 80, rows: 24 }, signal), info)

    const retained: any[] = []
    for await (const frame of controller.retain('mirror', 't1', signal)) retained.push(frame)
    assert.deepEqual(retained, [{ type: 'retained' }])

    controller.ctx = {
      invocation: {
        uplink: () => (async function* () {
          yield { type: 'write', sequence: 1, data: 'x' }
        })(),
      },
    }
    const frames: any[] = []
    for await (const frame of controller.attach(mirror, 't1', signal)) frames.push(frame)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(frames.length, 1)
    assert.deepEqual(inputs, [{ type: 'write', sequence: 1, data: 'x' }])

    await controller.rename(mirror, 't1', 'renamed')
    await controller.close(mirror, 't1')
    assert.deepEqual(remoteCalls, [
      'remote:environment:mirror',
      'remote:shells',
      'remote:list:mirror',
      'remote:create:mirror:t1',
      'remote:attach:t1',
      'remote:input:t1',
      'remote:rename:t1:renamed',
      'remote:close:t1',
    ])
    assert.deepEqual(localCalls, [])

    assert.deepEqual(controller.environment(local, signal).cwd, '/local')
    assert.deepEqual(await controller.shells(local, signal), [])
    assert.deepEqual(controller.list('local'), [])
    assert.deepEqual(localCalls, ['local:environment:local', 'local:shells', 'local:list'])
    assert.deepEqual(warnings, [])

    restore()
    assert.deepEqual(controller.environment(local, signal).cwd, '/local')
  })
})
