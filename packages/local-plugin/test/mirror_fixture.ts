import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from '../src/config.ts'
import { LocalError } from '../src/errors.ts'
import { RemoteMirrorService } from '../src/mirror/service.ts'
import type { RemoteHostsService } from '../src/service.ts'

/**
 * Build the failure the mirror actually observes for an unusable selection.
 *
 * `RemoteHostsService.promptSession` normalizes remote failures into a
 * `LocalError` carrying `details.remoteCode`, so the fixture reproduces that
 * final shape rather than the raw protocol error.
 */
function selectionRejection(selection: { provider: string; model: string }, legacy = false): LocalError {
  const code = legacy ? 'internal' : 'session/model-unavailable'
  return new LocalError('agent/error', legacy
    ? 'remote agent: remote agent request failed'
    : `remote agent: model ${selection.provider}/${selection.model} is not available on this remote host`, {
    details: { remoteCode: code },
    retryable: legacy,
  })
}

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
      ...meta.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset },
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
  const remoteCreates: Array<{ workspaceId?: string; cwd?: string; agentPreset?: string }> = []
  const prompts: Array<{ sessionId: string; text: string; selection?: { provider: string; model: string } }> = []
  /** Prompts the fixture refused because the selection was "unavailable". */
  const rejectedPrompts: Array<{ sessionId: string; text: string }> = []
  let rejectSelection: { provider: string; model: string } | undefined
  /** Whether the fixture reports the rejection the way a pre-fix agent did. */
  let legacyRejection = false
  /** Catalog the fixture advertises; undefined serves a single-provider default. */
  let catalog: {
    default: { provider: string; model: string }
    routableProviders: readonly string[]
    groups: readonly { id: string; name: string; models: readonly { id: string; name: string }[] }[]
    failures: readonly { id: string; name: string; message: string }[]
  } | undefined
  let catalogCalls = 0
  /** When true the fixture reports no routable models, like an unreachable host. */
  let catalogDisabled = false
  let blankRemoteSeq = 0
  let failPrompt = false
  let failEnter = false
  let createdPreset: string | undefined
  const attached: string[] = []
  const archived: string[] = []
  const remoteArchived: string[] = []
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

  const workspaces = new Map<string, { id: string; anchor: string; title: string; attachSession(id: string): Promise<void> }>()
  const registry = {
    get: (id: string) => workspaces.get(id),
    async create(anchor: string, title: string) {
      const existing = [...workspaces.values()].find(workspace => workspace.anchor === anchor)
      if (existing !== undefined) return existing
      workspaceSeq += 1
      const workspace = { id: `workspace-${workspaceSeq}`, anchor, title, attachSession: async (id: string) => { attached.push(id) } }
      workspaces.set(workspace.id, workspace)
      return workspace
    },
    async delete() {},
    async archiveSession(id: string) { archived.push(id) },
    async unarchiveSession() {},
  }

  const agents = {
    enter(agent: FixtureAgent) {
      if (failEnter) throw new Error('agent registration failed')
      if (liveAgents.has(agent.id)) throw new Error('agent already registered')
      liveAgents.set(agent.id, agent)
      return () => { liveAgents.delete(agent.id) }
    },
  }
  ctx.provide('sessions', store as never)
  ctx.provide('workspaceRegistry', registry as never)
  ctx.provide('agents', agents as never)
  ctx.logger.warn = (message: unknown, ...args: unknown[]) => { warnings.push([message, ...args].map(String).join(' ')) }

  const host: { id: string; label: string; phase: 'connected' | 'disconnected' } = { id: 'host-test', label: 'Test host', phase: 'connected' }
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
    async createSession(_host: string, request: { workspaceId?: string; cwd?: string; agentPreset?: string }) {
      remoteCreates.push(request)
      blankRemoteSeq += 1
      const id = `session-local-blank-${blankRemoteSeq}`
      remote = [...remote, {
        sessionId: id, workspaceId: request.workspaceId ?? 'remote-workspace',
        cwd: request.cwd ?? '/srv/project', createdAt: new Date().toISOString(),
        live: true, eventCount: 0,
      }]
      snapshots.set(id, { cursor: 0, live: true, truncated: false, events: [] })
      const preset = createdPreset ?? request.agentPreset
      return { sessionId: id, ...preset === undefined ? {} : { agentPreset: preset } }
    },
    async archiveSession(_host: string, sessionId: string) { remoteArchived.push(sessionId) },
    async modelCatalog(_host: string) {
      catalogCalls += 1
      if (catalogDisabled) return { default: { provider: 'remote-provider', model: 'remote-model' }, routableProviders: [], groups: [], failures: [] }
      if (catalog !== undefined) return catalog
      // Default catalog: one provider, model-agnostic so tests that select any
      // model id are still forwarded. Suites that care about rejection set an
      // explicit catalog or disable it.
      return {
        default: { provider: 'deepseek-official', model: 'deepseek-flash' },
        routableProviders: ['deepseek-official'],
        groups: [{
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: ['deepseek-flash', 'deepseek-reasoner', 'remote-model'].map(id => ({ id, name: id })),
        }],
        failures: [],
      }
    },
    async promptSession(_host: string, sessionId: string, text: string, _mode?: unknown, selection?: { provider: string; model: string }) {
      if (failPrompt) throw new Error('remote prompt failed')
      if (selection !== undefined && rejectSelection !== undefined
        && selection.provider === rejectSelection.provider && selection.model === rejectSelection.model) {
        rejectedPrompts.push({ sessionId, text })
        throw selectionRejection(selection, legacyRejection)
      }
      prompts.push({ sessionId, text, ...selection === undefined ? {} : { selection } })
      return { accepted: true }
    },
  } as unknown as RemoteHostsService

  const config = {
    stateDir,
    mirrorMaxEvents: 2_000,
    mirrorPollMs: 60_000,
    mirrorSessions: true,
  } as unknown as ResolvedConfig

  const service = new RemoteMirrorService(ctx, hosts, config)
  const newService = (): RemoteMirrorService => new RemoteMirrorService(ctx, hosts, config)

  return {
    service,
    newService,
    ctx,
    liveAgents,
    selections,
    remoteCreates,
    prompts,
    stateDir,
    sessions,
    attached,
    archived,
    remoteArchived,
    warnings,
    setRemote(next: Summary[]) { remote = next },
    setFailPrompt(value: boolean) { failPrompt = value },
    setRejectSelection(value: { provider: string; model: string } | undefined) { rejectSelection = value },
    setLegacyRejection(value: boolean) { legacyRejection = value },
    setCatalog(value: typeof catalog) { catalog = value; catalogCalls = 0 },
    /** Report an empty catalog so the prompt path cannot pre-check. */
    disableCatalog() { catalogDisabled = true; catalog = undefined },
    get catalogCalls() { return catalogCalls },
    rejectedPrompts,
    setFailEnter(value: boolean) { failEnter = value },
    setHostPhase(value: 'connected' | 'disconnected') { host.phase = value },
    setCreatedPreset(value: string | undefined) { createdPreset = value },
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
