import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { RemoteApprovalRequest, RemoteSessionSummary, RemoteWorkspace, SessionSnapshot } from '@dsh-remote/protocol'
import type { ResolvedConfig } from '../src/config.ts'
import { RemoteMirrorService } from '../src/mirror/service.ts'
import type { RemoteHostsService } from '../src/service.ts'

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

export async function removalFixture(nativeRegistry?: (ctx: Context) => Promise<void>) {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-remote-removal-'))
  const ctx = new Context()
  const warnings: unknown[] = []
  ctx.logger.warn = (...args: unknown[]) => { warnings.push(args) }
  const rows = new Map<string, ReturnType<typeof makeRow>>()
  const sessions = new Map<string, ReturnType<typeof makeSession>>()
  const agents = new Map<string, { id: string; cancel(): void; send(message: unknown): void }>()
  const effects = { cancellations: 0, prompts: 0, snapshots: 0, archives: 0, starts: 0, aborts: 0 }
  let flushGate: Promise<void> | undefined
  let flushEntered: (() => void) | undefined
  let rowSeq = 0
  const makeRow = (path: string, title: string) => ({
    id: `workspace-${++rowSeq}`, path, title,
    sessionIds: new Set<string>(),
    async attachSession(id: string) { this.sessionIds.add(id) },
  })
  const makeSession = (id: string, options: { seed?: SessionSnapshot['events']; meta?: Record<string, unknown> }) => {
    const events: Array<{ seq: number; type: string; data?: unknown }> = (options.seed ?? []).map(event => ({ ...event }))
    return {
      id, header: { id, version: 4, createdAt: Date.now(), isSeeded: false, ...options.meta }, seq: events.length,
      snapshotEvents: () => events,
      append(type: string, data: unknown) { const seq = events.length; events.push({ seq, type, data }); this.seq++; return seq },
    }
  }
  const registry = {
    get: (id: string) => rows.get(id),
    async create(path: string, title: string) {
      const existing = [...rows.values()].find(row => row.path === path)
      if (existing !== undefined) return existing
      const row = makeRow(path, title)
      rows.set(row.id, row)
      return row
    },
    async delete(id: string) {
      const existed = rows.delete(id)
      if (existed) ctx.emit('domain/changed', { domain: 'workspace', table: 'workspaces', key: id, operation: 'deleted' })
      return existed
    },
    async archiveSession() { effects.archives++ },
    async unarchiveSession() {},
  }
  ctx.provide('sessions', {
    get: (id: string) => sessions.get(id),
    list: () => [...sessions.values()],
    create(id: string, options: { seed?: SessionSnapshot['events']; meta?: Record<string, unknown> }) {
      assert.equal(sessions.has(id), false, 'local history must not be duplicated')
      const session = makeSession(id, options)
      sessions.set(id, session)
      return session
    },
    async flush() { flushEntered?.(); if (flushGate !== undefined) await flushGate },
  } as never)
  ctx.provide('agents', {
    enter(agent: { id: string; cancel(): void; send(message: unknown): void }) {
      assert.equal(agents.has(agent.id), false)
      agents.set(agent.id, agent)
      return () => { agents.delete(agent.id) }
    },
  } as never)
  if (nativeRegistry === undefined) ctx.provide('workspaceRegistry', registry as never)
  else await nativeRegistry(ctx)
  const host = { id: 'host-a', label: 'Host A', phase: 'connected' }
  const hostB = { id: 'host-b', label: 'Host B', phase: 'connected' }
  const workspace: RemoteWorkspace = { workspaceId: 'remote-project', path: '/srv/project', title: 'project' }
  let workspaces = [workspace]
  let catalog: RemoteSessionSummary[] = [{
    sessionId: 'remote-session', workspaceId: workspace.workspaceId, cwd: workspace.path,
    createdAt: '2026-01-01T00:00:00.000Z', live: true, eventCount: 1,
  }]
  const snapshots = new Map<string, SessionSnapshot>()
  const initialSnapshot: SessionSnapshot = {
    hostId: host.id, sessionId: 'remote-session', workspaceId: workspace.workspaceId, cwd: workspace.path,
    cursor: 1, live: true, truncated: false, events: [{ seq: 0, type: 'turn/start', data: { turn: 1 } }],
  }
  snapshots.set('remote-session', initialSnapshot)
  let snapshotGate: Promise<void> | undefined
  let snapshotEntered: (() => void) | undefined
  let eventGate: Promise<void> | undefined
  const approvals = new Map<string, ReturnType<typeof deferred<RemoteApprovalRequest>>>()
  const nextApproval = (hostId: string) => {
    let pending = approvals.get(hostId)
    if (pending === undefined) { pending = deferred<RemoteApprovalRequest>(); approvals.set(hostId, pending) }
    return pending
  }
  const answers: Array<{ hostId: string; requestId: string; outcome: string }> = []
  async function* follow(signal: AbortSignal, event?: unknown) {
    effects.starts++
    const aborted = deferred<void>()
    signal.addEventListener('abort', () => { effects.aborts++; aborted.resolve() }, { once: true })
    if (eventGate !== undefined) { await eventGate; if (event !== undefined) yield event }
    await aborted.promise
  }
  const hosts = {
    list: () => [host, hostB],
    workspaces: async () => workspaces,
    sessions: async () => ({ sessions: catalog }),
    snapshot: async (hostId: string, id: string) => {
      effects.snapshots++
      snapshotEntered?.()
      if (snapshotGate !== undefined) await snapshotGate
      return { ...snapshots.get(id)!, hostId }
    },
    followApprovals: async function* (hostId: string, signal: AbortSignal) {
      const aborted = deferred<undefined>()
      signal.addEventListener('abort', () => aborted.resolve(undefined), { once: true })
      while (!signal.aborted) {
        const request = await Promise.race([nextApproval(hostId).promise, aborted.promise])
        if (request === undefined) return
        approvals.delete(hostId)
        yield { type: 'request', request }
      }
    },
    async answerApproval(hostId: string, requestId: string, outcome: string) { answers.push({ hostId, requestId, outcome }) },
    followSessionEvents: (_host: string, _id: string, _after: number, signal: AbortSignal) =>
      follow(signal, { type: 'event', event: { seq: 1, type: 'turn/end', data: { turn: 1 } } }),
    followAssistantFrames: (_host: string, _id: string, signal: AbortSignal) => follow(signal),
    async setSandboxMode() {},
    async cancelSession() { effects.cancellations++ },
    async promptSession() { effects.prompts++ },
  } as unknown as RemoteHostsService
  const config = { stateDir, mirrorMaxEvents: 2000, mirrorPollMs: 500, mirrorSessions: true } as ResolvedConfig
  let service = new RemoteMirrorService(ctx, hosts, config)
  return {
    ctx, host, hostB, workspace, stateDir, rows, sessions, agents, registry, effects, warnings, snapshots, answers,
    async requestApproval(hostId: string, request: RemoteApprovalRequest) {
      nextApproval(hostId).resolve(request)
      await new Promise(done => setImmediate(done))
    },
    get service() { return service },
    setCatalog(next: RemoteSessionSummary[]) { catalog = next },
    setWorkspaces(next: RemoteWorkspace[]) { workspaces = next },
    gateSnapshots(gate: Promise<void>, entered: () => void) { snapshotGate = gate; snapshotEntered = entered },
    releaseSnapshots() { snapshotGate = undefined; snapshotEntered = undefined },
    gateFlush(gate: Promise<void>, entered: () => void) { flushGate = gate; flushEntered = entered },
    gateEvents(gate: Promise<void>) { eventGate = gate },
    async state() { return JSON.parse(await readFile(join(stateDir, 'mirrors.json'), 'utf8')) },
    async restart(beforeStart?: () => Promise<void>) {
      await service.dispose()
      await beforeStart?.()
      service = new RemoteMirrorService(ctx, hosts, config)
      await service.start()
    },
    async add(hostId = host.id, remote = workspace) { await ctx.parallel('dsh-remote/workspace-added', hostId, remote) },
    async close() { await service.dispose(); await rm(stateDir, { recursive: true, force: true }) },
  }
}
