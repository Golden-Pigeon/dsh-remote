import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { Context } from '@deepseek-ai/cordis'

import type { ResolvedConfig } from '../src/config.ts'
import { RemoteMirrorService } from '../src/mirror/service.ts'
import type { RemoteHostsService } from '../src/service.ts'

interface FixtureSelection { provider: string; model: string; reasoningEffort?: string }
interface FixtureAgent {
  id: string
  ctx: Context
  model: { current(): FixtureSelection; select(selection: FixtureSelection): void }
}

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

export function harness() {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-remote-mirror-subagents-'))
  tempDirs.push(stateDir)

  const ctx = new Context()
  const sessions = new Map<string, FakeSession>()
  const liveAgents = new Map<string, FixtureAgent>()
  const selections: unknown[] = []
  const attached: string[] = []
  const archived: string[] = []
  const warnings: string[] = []
  let workspaceSeq = 0

  const store = {
    get: (id: string) => sessions.get(id),
    create(id: string, options: { seed?: Snapshot['events']; meta?: Record<string, unknown> } = {}) {
      assert.equal(sessions.has(id), false, `session ${id} created twice`)
      const created = session(id, options.meta ?? {}, options.seed)
      const append = created.append
      created.append = (type, data) => {
        const seq = append(type, data)
        ctx.emit('session/event' as never, created as never, { type, data, seq } as never)
        return seq
      }
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

  const agents = {
    enter(agent: FixtureAgent) {
      if (liveAgents.has(agent.id)) throw new Error('agent already registered')
      liveAgents.set(agent.id, agent)
      return () => { liveAgents.delete(agent.id) }
    },
  }
  ctx.provide('sessions', store as never)
  ctx.provide('workspaceRegistry', registry as never)
  ctx.provide('agents', agents as never)
  ctx.logger.warn = (message: unknown, ...args: unknown[]) => { warnings.push([message, ...args].map(String).join(' ')) }

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
    async selectModel(_host: string, _session: string, selection: unknown) { selections.push(selection) },
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
    ctx,
    liveAgents,
    selections,
    stateDir,
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

export const parent: Summary = {
  sessionId: 'session-parent',
  workspaceId: 'remote-workspace',
  cwd: '/srv/project',
  createdAt: '2026-10-25T10:00:00.000Z',
  live: true,
  eventCount: 4,
}

export const child: Summary = {
  sessionId: 'child-1',
  workspaceId: null,
  cwd: '/srv/project',
  createdAt: '2026-10-25T10:01:00.000Z',
  live: true,
  eventCount: 3,
  origin: 'subagent',
  parentSession: 'session-parent',
}

export const grandchild: Summary = {
  sessionId: 'child-1-1',
  workspaceId: null,
  cwd: '/srv/project',
  createdAt: '2026-10-25T10:02:00.000Z',
  live: true,
  eventCount: 3,
  origin: 'subagent',
  parentSession: 'child-1',
}

export function parentSnapshot(childIds: string[]): Snapshot {
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

export function descriptorSnapshot(): Snapshot {
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
