import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import type { ResolvedConfig } from '../src/config.ts'
import { RemoteMirrorService } from '../src/mirror/service.ts'
import type { RemoteHostsService } from '../src/service.ts'

interface FakeSession {
  id: string
  header: Record<string, unknown>
  seq: number
  append(type: string, data: unknown): number
  snapshotEvents(): Array<{ seq: number; type: string; data: unknown }>
}

interface Summary {
  sessionId: string
  workspaceId: string | null
  cwd: string | null
  createdAt: string
  live: boolean
  eventCount: number | null
  origin?: 'subagent'
  parentSession?: string
}

interface Snapshot {
  cursor: number
  live: boolean
  truncated: boolean
  events: Array<{ seq: number; type: string; data?: unknown }>
}

const tempDirs: string[] = []

after(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

function session(id: string, meta: Record<string, unknown>, seed: Snapshot['events'] = []): FakeSession {
  const events = seed.map((event, index) => ({ seq: index, type: event.type, data: event.data ?? {} }))
  const record: FakeSession = {
    id,
    header: {
      version: 4,
      id,
      createdAt: meta.createdAt ?? Date.now(),
      cwd: meta.cwd,
      isSeeded: false,
      ...meta.parentSession === undefined ? {} : { parentSession: meta.parentSession },
      ...meta.origin === undefined ? {} : { origin: meta.origin },
    },
    seq: events.length,
    append(type, data) {
      const seq = record.seq
      events.push({ seq, type, data })
      record.seq += 1
      return seq
    },
    snapshotEvents: () => events,
  }
  return record
}

function harness() {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-remote-mirror-subagents-'))
  tempDirs.push(stateDir)

  const sessions = new Map<string, FakeSession>()
  const attached: string[] = []
  const archived: string[] = []
  const warnings: string[] = []
  let workspaceSeq = 0

  const store = {
    get: (id: string) => sessions.get(id),
    create(id: string, options: { seed?: Snapshot['events']; meta?: Record<string, unknown> } = {}) {
      assert.equal(sessions.has(id), false, `session ${id} created twice`)
      const created = session(id, options.meta ?? {}, options.seed)
      sessions.set(id, created)
      return created
    },
    flush: async () => {},
  }

  const registry = {
    async create(anchor: string, title: string) {
      workspaceSeq += 1
      return { id: `workspace-${workspaceSeq}`, anchor, title, attachSession: async (id: string) => { attached.push(id) } }
    },
    async delete() {},
    async archiveSession(id: string) { archived.push(id) },
    async unarchiveSession() {},
  }

  const agents = { enter: () => () => {} }

  const ctx = {
    get(name: string) {
      if (name === 'sessions') return store
      if (name === 'workspaceRegistry') return registry
      if (name === 'agents') return agents
      return undefined
    },
    logger: {
      info() {},
      debug() {},
      warn: (message: string, ...args: unknown[]) => { warnings.push([message, ...args].map(String).join(' ')) },
    },
    on: () => () => {},
    emit() {},
  } as unknown as Context

  const host = { id: 'host-test', label: 'Test host', phase: 'connected' }
  const workspace = { workspaceId: 'remote-workspace', path: '/srv/project', title: 'project' }
  let remote: Summary[] = []
  const snapshots = new Map<string, Snapshot>()

  const hosts = {
    list: () => [host],
    workspaces: async () => [workspace],
    sessions: async () => ({ sessions: remote }),
    snapshot: async (_hostId: string, sessionId: string) => {
      const snapshot = snapshots.get(sessionId)
      if (snapshot === undefined) throw new Error(`missing snapshot for ${sessionId}`)
      return {
        hostId: host.id,
        sessionId,
        workspaceId: null,
        cwd: '/srv/project',
        ...snapshot,
      }
    },
    async *followApprovals() {},
    async *followSessionEvents() {},
    async *followAssistantFrames() {},
    async setSandboxMode() {},
  } as unknown as RemoteHostsService

  const config = {
    stateDir,
    mirrorMaxEvents: 2_000,
    mirrorPollMs: 60_000,
    mirrorSessions: true,
  } as unknown as ResolvedConfig

  const service = new RemoteMirrorService(ctx, hosts, config)

  return {
    service,
    sessions,
    attached,
    archived,
    warnings,
    setRemote(next: Summary[]) { remote = next },
    setSnapshot(id: string, snapshot: Snapshot) { snapshots.set(id, snapshot) },
    async state(): Promise<{ sessions: Record<string, { remoteSessionId: string; localSessionId: string; parentSessionId?: string }> }> {
      return JSON.parse(await readFile(join(stateDir, 'mirrors.json'), 'utf8'))
    },
  }
}

const parent: Summary = {
  sessionId: 'session-parent',
  workspaceId: 'remote-workspace',
  cwd: '/srv/project',
  createdAt: '2026-10-25T10:00:00.000Z',
  live: true,
  eventCount: 4,
}

const child: Summary = {
  sessionId: 'child-1',
  workspaceId: null,
  cwd: '/srv/project',
  createdAt: '2026-10-25T10:01:00.000Z',
  live: true,
  eventCount: 3,
  origin: 'subagent',
  parentSession: 'session-parent',
}

const grandchild: Summary = {
  sessionId: 'child-1-1',
  workspaceId: null,
  cwd: '/srv/project',
  createdAt: '2026-10-25T10:02:00.000Z',
  live: true,
  eventCount: 3,
  origin: 'subagent',
  parentSession: 'child-1',
}

function parentSnapshot(childIds: string[]): Snapshot {
  return {
    cursor: childIds.length + 3,
    live: true,
    truncated: false,
    events: [
      { seq: 0, type: 'turn/start', data: { turn: 1 } },
      { seq: 1, type: 'user/message', data: { id: 'm1', role: 'user', content: [] } },
      ...childIds.map((childId, index) => ({
        seq: 2 + index,
        type: 'subagent/catalog',
        data: { version: 0, childId, childCreatedAt: 1, mode: 'continuable', label: `child ${childId}` },
      })),
      { seq: childIds.length + 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  }
}

function descriptorSnapshot(): Snapshot {
  return {
    cursor: 2,
    live: true,
    truncated: false,
    events: [
      {
        seq: 0,
        type: 'subagent/descriptor',
        data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'child', agentProvider: 'deepseek-official', agentModel: 'deepseek-flash' },
      },
      { seq: 1, type: 'turn/start', data: { turn: 1 } },
    ],
  }
}

describe('mirror subagent sessions', () => {
  it('mirrors remote subagent children under their local parent, including nested children', async () => {
    const test = harness()
    test.setRemote([parent, child, grandchild])
    test.setSnapshot('session-parent', parentSnapshot(['child-1']))
    test.setSnapshot('child-1', descriptorSnapshot())
    test.setSnapshot('child-1-1', descriptorSnapshot())

    try {
      await test.service.sync()
      const state = await test.state()
      const records = Object.values(state.sessions)
      const parentRecord = records.find(record => record.remoteSessionId === 'session-parent')
      const childRecord = records.find(record => record.remoteSessionId === 'child-1')
      const grandchildRecord = records.find(record => record.remoteSessionId === 'child-1-1')

      assert.ok(parentRecord !== undefined)
      assert.ok(childRecord !== undefined)
      assert.ok(grandchildRecord !== undefined)
      assert.equal(childRecord.parentSessionId, parentRecord.localSessionId)
      assert.equal(grandchildRecord.parentSessionId, childRecord.localSessionId)

      const mirroredChild = test.sessions.get('child-1')
      assert.ok(mirroredChild !== undefined)
      assert.equal(mirroredChild.header.origin, 'subagent')
      assert.equal(mirroredChild.header.parentSession, parentRecord.localSessionId)
      assert.equal(mirroredChild.header.cwd, parentRecord.anchor)
      assert.ok(mirroredChild.snapshotEvents().some(event => event.type === 'subagent/descriptor'))

      assert.ok(test.attached.includes(parentRecord.localSessionId), 'parent attaches to the workspace row')
      assert.equal(test.attached.includes('child-1'), false, 'child is not a workspace row')

      const created = test.sessions.size
      await test.service.sync()
      assert.equal(test.sessions.size, created, 'second sync reuses every mirror session')
      assert.equal(Object.keys((await test.state()).sessions).length, records.length)
    } finally {
      await test.service.dispose()
    }
  })

  it('prunes only children the remote no longer reports', async () => {
    const test = harness()
    test.setRemote([parent, child])
    test.setSnapshot('session-parent', parentSnapshot(['child-1']))
    test.setSnapshot('child-1', descriptorSnapshot())

    try {
      await test.service.sync()
      assert.ok(test.sessions.has('child-1'))

      test.setRemote([parent])
      await test.service.sync()
      const records = Object.values((await test.state()).sessions)
      assert.equal(records.some(record => record.remoteSessionId === 'child-1'), false)
      assert.ok(test.archived.includes('child-1'))
      // The parent mirror itself is never pruned by the subagent cleanup.
      assert.ok(records.some(record => record.remoteSessionId === 'session-parent'))
    } finally {
      await test.service.dispose()
    }
  })

  it('leaves a child unmirrored when its window lost the descriptor', async () => {
    const test = harness()
    test.setRemote([parent, child])
    test.setSnapshot('session-parent', parentSnapshot(['child-1']))
    test.setSnapshot('child-1', {
      cursor: 3_000,
      live: true,
      truncated: true,
      events: [
        { seq: 2_500, type: 'turn/start', data: { turn: 9 } },
        { seq: 2_501, type: 'user/message', data: { id: 'u9', role: 'user', content: [] } },
      ],
    })

    try {
      await test.service.sync()
      assert.equal(test.sessions.has('child-1'), false)
      assert.ok(test.warnings.some(line => line.includes('has no descriptor')))
      assert.equal(
        Object.values((await test.state()).sessions).some(record => record.remoteSessionId === 'child-1'),
        false,
      )
    } finally {
      await test.service.dispose()
    }
  })
})
