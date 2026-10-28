import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { describe, it } from 'node:test'
import Storage, { type StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry, { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { deferred, removalFixture } from './workspace_removal_fixture.ts'

async function nativeFixture() {
  let beforeDelete = async () => {}
  let close!: () => Promise<void>
  const f = await removalFixture(async ctx => {
    await ctx.plugin(Storage)
    const tables = new Map<string, Map<string, unknown>>()
    let global: unknown = null
    const backend: StorageBackend = {
      kv: {
        async open() {
          return {
            async loadAll() { return { tables: Object.fromEntries([...tables].map(([name, records]) => [name, Object.fromEntries(records)])), global } },
            async putRecord(table, key, value) {
              if (!tables.has(table)) tables.set(table, new Map())
              tables.get(table)!.set(key, value)
            },
            async deleteRecord(table, key) { await beforeDelete(); tables.get(table)?.delete(key) },
            async deleteRecords(table, keys) { for (const key of keys) tables.get(table)?.delete(key) },
            async setGlobal(value) { global = value },
            async close() {},
          }
        },
      },
      async close() {},
    }
    ctx.storage.backend.register('removal-test', backend)
    const domain = new DomainFacility(ctx, { backend: 'removal-test', routes: {} })
    ctx.storage.mount('domain', domain)
    ctx.provide('storageDomain', domain)
    ctx.provide('sessionPersistence', { list: async () => [], open: () => { throw new Error('unexpected history read') } } as never)
    const fiber = await ctx.plugin(WorkspaceRegistry)
    close = () => fiber.dispose()
  })
  f.hostB.phase = 'disconnected'
  return { ...f, get service() { return f.service }, setDelete: (fn: () => Promise<void>) => { beforeDelete = fn }, close: async () => { await f.service.dispose(); await close(); await f.close() } }
}

describe('native workspace registry removal', () => {
  it('uses the native durable deletion event, keeps directories and history, and restores only on add', async () => {
    const f = await nativeFixture()
    try {
      await f.service.start()
      const registry = f.ctx.workspaceRegistry
      const id = f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId)!
      const row = registry.get(WorkspaceId(id))!
      const sessionId = f.service.localSessionId(f.host.id, 'remote-session')!
      assert.equal(await registry.delete(WorkspaceId(id)), true)
      await f.service.sync()
      await f.service.sync()
      assert.equal(registry.list().length, 0)
      await access(row.path)
      assert.equal(f.sessions.has(sessionId), true)
      assert.equal(f.agents.size, 0)
      assert.equal(f.effects.cancellations, 0)
      await f.add()
      assert.equal(registry.list().length, 1)
      assert.equal(f.service.localSessionId(f.host.id, 'remote-session'), sessionId)
      assert.equal(f.agents.size, 1)
    } finally { await f.close() }
  })

  it('does not persist a removal while the native delete is pending and then rolls back', async () => {
    const f = await nativeFixture()
    const gate = deferred<void>()
    const entered = deferred<void>()
    try {
      await f.service.start()
      const registry = f.ctx.workspaceRegistry
      const id = f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId)!
      f.setDelete(async () => { entered.resolve(); await gate.promise; throw new Error('injected durable delete failure') })
      const deletion = registry.delete(WorkspaceId(id))
      const rejected = assert.rejects(deletion, /injected durable delete failure/)
      await entered.promise
      assert.equal(registry.get(WorkspaceId(id)), undefined, 'native cache is temporarily unpublished')
      await f.service.sync()
      assert.equal(f.service.isWorkspaceRemoved(f.host.id, f.workspace.workspaceId), false)
      gate.resolve()
      await rejected
      await f.service.sync()
      assert.ok(registry.get(WorkspaceId(id)))
      assert.equal(f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId), id)
      assert.equal(f.agents.size, 1)
      assert.equal(f.effects.cancellations, 0)
    } finally { gate.resolve(); await f.close() }
  })

  it('reads an already-pending native delete on startup without mistaking a failed write for removal', async () => {
    const f = await nativeFixture()
    const gate = deferred<void>()
    const entered = deferred<void>()
    try {
      await f.service.start()
      const registry = f.ctx.workspaceRegistry
      const id = f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId)!
      await f.service.dispose()
      f.setDelete(async () => { entered.resolve(); await gate.promise; throw new Error('injected durable delete failure') })
      const rejected = assert.rejects(registry.delete(WorkspaceId(id)), /injected durable delete failure/)
      await entered.promise
      await f.restart()
      assert.equal(f.service.isWorkspaceRemoved(f.host.id, f.workspace.workspaceId), false)
      gate.resolve()
      await rejected
      await f.service.sync()
      assert.equal(f.service.localWorkspaceId(f.host.id, f.workspace.workspaceId), id)
      assert.equal(f.agents.size, 1)
    } finally { gate.resolve(); await f.close() }
  })

})
