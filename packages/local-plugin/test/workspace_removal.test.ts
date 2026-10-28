import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { registerHostApi } from '../src/host-api/handler.ts'
import type { RemoteHostsService } from '../src/service.ts'
import { deferred, removalFixture } from './workspace_removal_fixture.ts'

function timeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture operation timed out')), 5000)
    timer.unref()
  })])
}

describe('local remote-workspace removal', () => {
  it('leaves approvals for a removed mirror pending instead of denying remote work', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    try {
      await f.service.start()
      await f.registry.delete(f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId)!)
      await f.requestApproval(f.host.id, { id: 'removed-approval', sessionId: 'remote-session', toolName: 'shell' })
      assert.deepEqual(f.answers, [])
      await f.requestApproval(f.host.id, { id: 'unknown-approval', sessionId: 'unknown-session', toolName: 'shell' })
      assert.deepEqual(f.answers, [{ hostId: f.host.id, requestId: 'unknown-approval', outcome: 'unavailable' }])
    } finally { await f.close() }
  })

  it('does not forward a pending local approval result after its workspace is removed', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    const entered = deferred<void>()
    const outcome = deferred<string>()
    const off = f.ctx.on('approval/request' as never, (() => {
      entered.resolve()
      return outcome.promise
    }) as never, { global: true } as never)
    try {
      await f.service.start()
      await f.requestApproval(f.host.id, { id: 'pending-approval', sessionId: 'remote-session', toolName: 'shell' })
      await timeout(entered.promise)
      await f.registry.delete(f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId)!)
      outcome.resolve('unavailable')
      await new Promise(done => setImmediate(done))
      assert.deepEqual(f.answers, [])
    } finally { outcome.resolve('unavailable'); off(); await f.close() }
  })

  it('does not require the workspace registry while forwarding an existing approval', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    try {
      await f.service.start()
      f.ctx.reflect.set('workspaceRegistry', undefined as never)
      await f.requestApproval(f.host.id, { id: 'active-approval', sessionId: 'remote-session', toolName: 'shell' })
      assert.deepEqual(f.answers, [{ hostId: f.host.id, requestId: 'active-approval', outcome: 'unavailable' }])
    } finally { f.ctx.reflect.set('workspaceRegistry', f.registry as never); await f.close() }
  })

  it('restores a removed workspace when explicit re-add returns a new remote id at the same path', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    try {
      await f.service.start()
      const oldId = f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId)!
      const anchor = f.rows.get(oldId)!.path
      const localId = f.service.localSessionId(f.host.id, 'remote-session')!
      await f.registry.delete(oldId)
      const replacement = { ...f.workspace, workspaceId: 'replacement-project' }
      f.setWorkspaces([replacement])
      f.setCatalog([{ sessionId: 'remote-session', workspaceId: replacement.workspaceId, cwd: replacement.path,
        createdAt: '2026-01-01T00:00:00.000Z', live: true, eventCount: 1 }])
      await f.service.sync()
      assert.equal(f.rows.size, 0)
      await f.add(f.host.id, replacement)
      assert.equal(f.rows.size, 1)
      assert.equal([...f.rows.values()][0]!.path, anchor)
      assert.equal(f.service.localSessionId(f.host.id, 'remote-session'), localId)
      const state = await f.state()
      assert.equal(state.workspaces[`${f.host.id}:${f.workspace.workspaceId}`], undefined)
      assert.equal(state.workspaces[`${f.host.id}:${replacement.workspaceId}`].removed, false)
    } finally { await f.close() }
  })

  it('migrates legacy hidden records before missing-row detection and restores their history on unhide', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    try {
      await f.service.start()
      const oldId = f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId)!
      const localId = f.service.localSessionId(f.host.id, 'remote-session')!
      await f.restart(async () => {
        const state = await f.state()
        state.testHidden = [`${f.host.id}:${f.workspace.workspaceId}`]
        await writeFile(join(f.stateDir, 'mirrors.json'), JSON.stringify(state))
        await writeFile(join(f.stateDir, 'test-visibility.json'), JSON.stringify({ hiddenPaths: [f.workspace.path] }))
        f.rows.delete(oldId) // Older plugin versions left this id in mirrors.json after their own hide.
      })
      assert.equal(f.service.isWorkspaceRemoved(f.host.id, f.workspace.workspaceId), false)
      assert.equal(f.rows.size, 0)
      await writeFile(join(f.stateDir, 'test-visibility.json'), JSON.stringify({ hiddenPaths: [] }))
      await f.service.sync()
      assert.equal(f.rows.size, 1)
      assert.equal(f.service.localSessionId(f.host.id, 'remote-session'), localId)
      assert.equal(f.sessions.size, 1)
    } finally { await f.close() }
  })

  it('stops subscriptions without cancelling remote work and does not recreate on discovery', async () => {
    const f = await removalFixture()
    try {
      await f.service.start()
      const id = f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId)!
      const localId = f.service.localSessionId(f.host.id, 'remote-session')!
      const staleAgent = f.agents.get(localId)!
      const native = await f.registry.create('/srv/native-local', 'local')
      const otherId = f.service.localWorkspaceId(f.hostB.id, f.workspace.workspaceId)!
      await f.registry.delete(id)
      const archiveDeadline = Date.now() + 2_000
      while (f.effects.archives === 0 && Date.now() < archiveDeadline) {
        await new Promise<void>(done => setTimeout(done, 5))
      }
      assert.equal(f.effects.aborts, 2)
      assert.equal(f.agents.has(localId), false)
      await f.service.sync()
      await f.service.sync()
      assert.equal(f.rows.has(id), false)
      assert.equal(f.rows.has(otherId), true)
      assert.equal(f.rows.has(native.id), true)
      assert.equal(f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId), undefined)
      assert.equal(await f.service.ensureRemoteSession(f.host.id, 'remote-session'), undefined)
      staleAgent.cancel()
      staleAgent.send({ role: 'user', content: [{ type: 'text', text: 'must stay detached' }] })
      await Promise.resolve()
      assert.equal(f.effects.cancellations, 0)
      assert.equal(f.effects.prompts, 0)
      assert.equal(f.effects.archives > 0, true)
      assert.equal(f.sessions.has(localId), true)
      await f.service.dispose()
      const state = await f.state()
      assert.equal(state.workspaces[`${f.host.id}:${f.workspace.workspaceId}`].removed, true)
    } finally { await f.close() }
  })

  it('persists removal across restart and explicit re-add reuses history and replays the completed suffix', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    try {
      await f.service.start()
      const id = f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId)!
      const localId = f.service.localSessionId(f.host.id, 'remote-session')!
      const session = f.sessions.get(localId)!
      const staleAgent = f.agents.get(localId)!
      await f.registry.delete(id)
      const snapshot = f.snapshots.get('remote-session')!
      snapshot.events.push({ seq: 1, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      snapshot.cursor = 2
      snapshot.live = false
      f.setCatalog([{ sessionId: 'remote-session', workspaceId: f.workspace.workspaceId, cwd: f.workspace.path,
        createdAt: '2026-01-01T00:00:00.000Z', live: false, eventCount: 2 }])
      await f.restart()
      assert.equal(f.rows.size, 0)
      const reads = f.effects.snapshots
      await f.service.sync()
      assert.equal(f.effects.snapshots, reads)
      await f.add()
      assert.equal(f.rows.size, 1)
      assert.equal(f.effects.unarchives > 0, true)
      assert.equal(f.service.localSessionId(f.host.id, 'remote-session'), localId)
      assert.equal(f.sessions.size, 1)
      assert.deepEqual(session.snapshotEvents().map(event => event.type), ['turn/start', 'turn/end'])
      assert.equal(f.agents.has(localId), true)
      staleAgent.cancel()
      staleAgent.send({ content: [{ type: 'text', text: 'stale' }] })
      await Promise.resolve()
      assert.equal(f.effects.cancellations, 0)
      assert.equal(f.effects.prompts, 0)
      await f.service.sync()
      assert.equal(session.seq, 2, 'catalog reconciliation must not replay the suffix twice')
    } finally { await f.close() }
  })

  it('recognizes a deletion made while the plugin was stopped', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    try {
      await f.service.start()
      const id = f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId)!
      await f.service.dispose()
      await f.registry.delete(id)
      await f.restart()
      assert.equal(f.rows.size, 0)
      assert.equal(f.agents.size, 0)
      assert.equal(f.service.isWorkspaceRemoved(f.host.id, f.workspace.workspaceId), true)
      await f.add()
      assert.equal(f.rows.size, 1)
    } finally { await f.close() }
  })

  it('archives sessions when the persisted removal predates archival', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    try {
      await f.service.start()
      const id = f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId)!
      await f.registry.delete(id)
      const archiveDeadline = Date.now() + 2_000
      while (f.effects.archives === 0 && Date.now() < archiveDeadline) {
        await new Promise<void>(done => setTimeout(done, 5))
      }
      assert.equal(f.effects.archives > 0, true)
      f.effects.archives = 0
      await f.restart()
      assert.equal(f.effects.archives > 0, true)
    } finally { await f.close() }
  })

  it('ignores unrelated changes and a native deletion that rolls back before durability', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    try {
      await f.service.start()
      const id = f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId)!
      const row = f.rows.get(id)!
      f.ctx.emit('domain/changed', { domain: 'workspace', table: '', key: '', operation: 'put',
        value: { pendingMutation: { operation: 'delete', workspaceId: id } } })
      f.rows.delete(id) // The native registry temporarily unpublishes before the backend resolves.
      await f.service.sync()
      assert.equal(f.service.isWorkspaceRemoved(f.host.id, f.workspace.workspaceId), false)
      f.rows.set(id, row)
      f.ctx.emit('domain/changed', { domain: 'workspace', table: '', key: '', operation: 'put', value: {} })
      f.ctx.emit('domain/changed', { domain: 'other', table: 'workspaces', key: id, operation: 'deleted' })
      await f.service.sync()
      assert.equal(f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId), id)
      assert.equal(f.agents.size, 1)
    } finally { await f.close() }
  })

  it('does not mount a mirror from a snapshot completing after local removal', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    const gate = deferred<void>()
    const entered = deferred<void>()
    f.gateSnapshots(gate.promise, () => entered.resolve())
    try {
      const start = f.service.start()
      await timeout(entered.promise)
      const id = f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId)!
      await f.registry.delete(id)
      gate.resolve()
      await timeout(start)
      assert.equal(f.agents.size, 0)
      assert.equal(f.sessions.size, 0)
      assert.equal(f.rows.size, 0)
    } finally { gate.resolve(); await f.close() }
  })

  it('keeps a newly seeded local history mapped when removal races its first flush', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    const gate = deferred<void>()
    const entered = deferred<void>()
    f.gateFlush(gate.promise, () => entered.resolve())
    try {
      const start = f.service.start()
      await timeout(entered.promise)
      const [localId] = f.sessions.keys()
      await f.registry.delete(f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId)!)
      gate.resolve()
      await timeout(start)
      assert.equal(f.agents.size, 0)
      await f.restart()
      await f.add()
      assert.equal(f.service.localSessionId(f.host.id, 'remote-session'), localId)
      assert.equal(f.sessions.size, 1)
    } finally { gate.resolve(); await f.close() }
  })

  it('drops an in-flight poll result and late stream frames after removal', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    const streamGate = deferred<void>()
    f.gateEvents(streamGate.promise)
    const pollGate = deferred<void>()
    const entered = deferred<void>()
    try {
      await f.service.start()
      const localId = f.service.localSessionId(f.host.id, 'remote-session')!
      const session = f.sessions.get(localId)!
      f.gateSnapshots(pollGate.promise, () => entered.resolve())
      await timeout(entered.promise)
      const snapshot = f.snapshots.get('remote-session')!
      snapshot.events.push({ seq: 1, type: 'turn/end', data: { turn: 1 } })
      snapshot.cursor = 2
      await f.registry.delete(f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId)!)
      streamGate.resolve()
      pollGate.resolve()
      await new Promise(done => setImmediate(done))
      assert.equal(session.seq, 1)
      assert.equal(f.agents.size, 0)
      assert.equal(f.effects.cancellations, 0)
    } finally { pollGate.resolve(); streamGate.resolve(); await f.close() }
  })

  it('restores an unregistered cwd as a real workspace without duplicating its parent or children', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    f.setWorkspaces([])
    const parent = { sessionId: 'remote-session', workspaceId: null, cwd: f.workspace.path,
      createdAt: '2026-01-01T00:00:00.000Z', live: true, eventCount: 1 }
    const child = { ...parent, sessionId: 'child-session', origin: 'subagent' as const, parentSession: parent.sessionId }
    f.setCatalog([parent, child])
    f.snapshots.set(child.sessionId, { ...f.snapshots.get(parent.sessionId)!, sessionId: child.sessionId,
      events: [{ seq: 0, type: 'subagent/descriptor', data: { version: 3 } }], cursor: 1 })
    try {
      await f.service.start()
      const [row] = f.rows.values()
      const localIds = [...f.sessions.keys()]
      await f.registry.delete(row!.id)
      assert.equal(f.agents.size, 0)
      f.setCatalog([parent])
      await f.service.sync()
      assert.equal(f.rows.size, 0)
      assert.equal(Object.keys((await f.state()).sessions).length, 2, 'removed children stay frozen even when absent from discovery')
      f.setWorkspaces([f.workspace])
      f.setCatalog([{ ...parent, workspaceId: f.workspace.workspaceId }, child])
      await f.service.sync()
      assert.equal(f.rows.size, 0, 'ordinary remote registration is not an explicit local re-add')
      await f.add()
      assert.equal(f.rows.size, 1)
      assert.deepEqual([...f.sessions.keys()], localIds)
      assert.equal(f.agents.size, 2)
      assert.equal(f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId), [...f.rows.keys()][0])
      assert.equal([...f.rows.values()][0]?.path, row!.path, 'the original history anchor is retained')
      assert.equal(f.effects.cancellations, 0)
    } finally { await f.close() }
  })

  it('does not mirror a removed workspace session whose cwd is a subdirectory', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    try {
      await f.service.start()
      const id = f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId)!
      await f.registry.delete(id)
      const cwd = `${f.workspace.path}/sub`
      f.setCatalog([{ sessionId: 'sub-session', workspaceId: f.workspace.workspaceId, cwd,
        createdAt: '2026-01-01T00:00:00.000Z', live: true, eventCount: 1 }])
      f.snapshots.set('sub-session', { hostId: f.host.id, sessionId: 'sub-session', workspaceId: f.workspace.workspaceId,
        cwd, cursor: 1, live: true, truncated: false, events: [] })
      await f.service.sync()
      assert.equal(f.rows.size, 0)
      assert.equal(f.service.localSessionId(f.host.id, 'sub-session'), undefined)
    } finally { await f.close() }
  })

  it('keeps plugin-owned test hiding reversible without recording a user removal', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    try {
      await f.service.start()
      const manifest = join(f.stateDir, 'test-visibility.json')
      await writeFile(manifest, JSON.stringify({ hiddenPaths: [f.workspace.path] }))
      await f.service.sync()
      assert.equal(f.rows.size, 0)
      assert.equal(f.service.isWorkspaceRemoved(f.host.id, f.workspace.workspaceId), false)
      await writeFile(manifest, JSON.stringify({ hiddenPaths: [] }))
      await f.service.sync()
      assert.equal(f.rows.size, 1)
    } finally { await f.close() }
  })

  it('rejects session creation for a removed workspace before writing to the remote', async () => {
    const f = await removalFixture()
    f.hostB.phase = 'disconnected'
    let fetch!: (request: Request) => Promise<Response>
    let creates = 0
    f.ctx.provide('connection', { fetch: { register: (route: { fetch: typeof fetch }) => {
      fetch = route.fetch
      return async () => {}
    } } } as never)
    const dispose = registerHostApi(f.ctx, { createSession: async () => { creates++; return { sessionId: 'created' } } } as unknown as RemoteHostsService, f.service)
    try {
      await f.service.start()
      await f.registry.delete(f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId)!)
      const response = await fetch(new Request('http://localhost/api/dsh-remote', {
        method: 'POST', body: JSON.stringify({ endpoint: 'host/session/create',
          payload: { hostId: f.host.id, workspaceId: f.workspace.workspaceId } }),
      }))
      const result = await response.json()
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'request/invalid')
      assert.match(result.error.message, /Add it again/)
      const subResponse = await fetch(new Request('http://localhost/api/dsh-remote', {
        method: 'POST', body: JSON.stringify({ endpoint: 'host/session/create',
          payload: { hostId: f.host.id, cwd: `${f.workspace.path}/sub` } }),
      }))
      const subResult = await subResponse.json()
      assert.equal(subResult.ok, false)
      assert.equal(subResult.error.code, 'request/invalid')
      assert.match(subResult.error.message, /Add it again/)
      assert.equal(creates, 0)
    } finally { await dispose(); await f.close() }
  })

})
