/**
 * Deterministic fixtures for the fake remote host.
 *
 * @module @dsh-remote/testkit/fixtures
 */

import type {
  AgentCapability,
  HostInfo,
  RemoteSessionEvent,
  RemoteSessionSummary,
  RemoteWorkspace,
} from '@dsh-remote/protocol'

/** One fake workspace. */
export interface FakeWorkspace extends RemoteWorkspace {}

/** One fake session with its event log. */
export interface FakeSession {
  readonly sessionId: string
  readonly workspaceId: string | null
  readonly cwd: string | null
  readonly createdAt: string
  readonly live: boolean
  events: RemoteSessionEvent[]
}

/** Fixture set returned by {@link createFixtures}. */
export interface Fixtures {
  readonly hostInfo: HostInfo
  readonly workspaces: FakeWorkspace[]
  readonly sessions: FakeSession[]
}

/** Build deterministic fixtures with two workspaces and three sessions. */
export function createFixtures(hostId = 'fake-host'): Fixtures {
  const t0 = Date.parse('2026-01-01T00:00:00.000Z')
  const event = (seq: number, type: string, data: Record<string, unknown>): RemoteSessionEvent => ({
    seq,
    type,
    time: t0 + seq * 1_000,
    data: data as RemoteSessionEvent['data'],
  })
  const sessions: FakeSession[] = [
    {
      sessionId: 'session-alpha',
      workspaceId: 'workspace-alpha',
      cwd: '/srv/alpha',
      createdAt: new Date(t0).toISOString(),
      live: true,
      events: [
        event(0, 'turn/start', { turn: 1 }),
        event(1, 'user/message', { content: 'hello' }),
        event(2, 'assistant/message', { content: 'hi' }),
        event(3, 'turn/end', { turn: 1, reason: 'complete' }),
      ],
    },
    {
      sessionId: 'session-beta',
      workspaceId: 'workspace-alpha',
      cwd: '/srv/alpha',
      createdAt: new Date(t0 + 60_000).toISOString(),
      live: false,
      events: [
        event(0, 'turn/start', { turn: 1 }),
        event(1, 'user/message', { content: 'cold prompt' }),
      ],
    },
    {
      sessionId: 'session-gamma',
      workspaceId: null,
      cwd: '/tmp',
      createdAt: new Date(t0 + 120_000).toISOString(),
      live: true,
      events: [
        event(0, 'turn/start', { turn: 1 }),
      ],
    },
  ]

  const workspaces: FakeWorkspace[] = [
    {
      workspaceId: 'workspace-alpha',
      path: '/srv/alpha',
      title: 'Alpha',
      sessionIds: ['session-alpha', 'session-beta'],
      createdAt: new Date(t0).toISOString(),
      updatedAt: new Date(t0 + 60_000).toISOString(),
    },
    {
      workspaceId: 'workspace-beta',
      path: '/srv/beta',
      title: 'Beta',
      sessionIds: [],
      createdAt: new Date(t0 + 30_000).toISOString(),
      updatedAt: new Date(t0 + 30_000).toISOString(),
    },
  ]

  const capabilities: AgentCapability[] = [
    'health',
    'host.info',
    'workspace.list',
    'session.list',
    'session.snapshot',
    'session.follow',
    'web.url',
  ]
  const hostInfo: HostInfo = {
    hostId,
    hostname: 'fake-remote',
    platform: 'linux',
    arch: 'x64',
    dshVersion: '0.2.1-rc.2',
    agentVersion: '0.1.0',
    home: '/home/fake',
    startedAt: new Date(t0).toISOString(),
    protocolVersion: 1,
    capabilities,
    workspaceCount: workspaces.length,
  }

  return { hostInfo, workspaces, sessions }
}

/** Project one fake session to the wire summary. */
export function summarize(session: FakeSession): RemoteSessionSummary {
  return {
    sessionId: session.sessionId,
    workspaceId: session.workspaceId,
    cwd: session.cwd,
    createdAt: session.createdAt,
    live: session.live,
    eventCount: session.events.length,
  }
}
