import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import {
  EventCursor,
  RemoteAgentClient,
  RemoteProtocolError,
  type SessionStreamFrame,
} from '@dsh-remote/protocol'
import { FakeRemoteHost } from '../src/fake-host.ts'

const TOKEN = 'contract-token-0123456789'
let host: FakeRemoteHost
let baseUrl: string

before(async () => {
  host = new FakeRemoteHost({ token: TOKEN })
  const address = await host.start()
  baseUrl = address.baseUrl
})

after(async () => {
  await host.stop()
})

function client(token = TOKEN): RemoteAgentClient {
  return new RemoteAgentClient({ baseUrl, token, hostId: 'contract-host', timeoutMs: 5_000 })
}

describe('remote agent wire contract', () => {
  it('serves health with a stable host identity', async () => {
    const health = await client().health()
    assert.equal(health.hostId, 'contract-host')
    assert.equal(health.protocolVersion, 1)
    assert.ok(health.capabilities.includes('session.follow'))
    assert.equal(health.workspaceCount, 2)
  })

  it('lists workspaces and filters sessions by workspace', async () => {
    const workspaces = await client().listWorkspaces()
    assert.equal(workspaces.length, 2)
    assert.deepEqual(workspaces[0]?.sessionIds, ['session-alpha', 'session-beta'])

    const alpha = await client().listSessions('workspace-alpha')
    assert.deepEqual(alpha.map(session => session.sessionId).sort(), ['session-alpha', 'session-beta'])
    const beta = await client().listSessions('workspace-beta')
    assert.deepEqual(beta, [])
  })

  it('returns an ungrouped session in the global list', async () => {
    const sessions = await client().listSessions()
    assert.equal(sessions.length, 3)
    const gamma = sessions.find(session => session.sessionId === 'session-gamma')
    assert.equal(gamma?.workspaceId, null)
    assert.equal(gamma?.cwd, '/tmp')
  })

  it('creates a workspace, creates a session, and prompts it', async () => {
    const workspace = await client().createWorkspace({ path: '/srv/created', title: 'Created' })
    assert.equal(workspace.title, 'Created')
    assert.equal((await client().listWorkspaces()).some(item => item.workspaceId === workspace.workspaceId), true)

    const created = await client().createSession({ workspaceId: workspace.workspaceId })
    assert.match(created.sessionId, /^session-created-/)
    const prompt = await client().promptSession(created.sessionId, { text: 'hello remote' })
    assert.deepEqual(prompt, undefined)
    const snapshot = await client().snapshotSession(created.sessionId)
    assert.deepEqual(snapshot.events.map(event => event.type), ['user/message', 'assistant/message'])
    const assistant = snapshot.events[1]?.data as { message?: { content?: Array<{ text?: string }> } }
    assert.equal(assistant.message?.content?.[0]?.text, 'echo: hello remote')
    assert.deepEqual(await client().cancelSession(created.sessionId), undefined)
  })

  it('snapshots the newest page and reports truncation', async () => {
    const full = await client().snapshotSession('session-alpha')
    assert.equal(full.cursor, 4)
    assert.equal(full.events.length, 4)
    assert.equal(full.truncated, false)
    assert.equal(full.workspaceId, 'workspace-alpha')

    const tail = await client().snapshotSession('session-alpha', { limit: 2 })
    assert.equal(tail.events.length, 2)
    assert.equal(tail.events[0]?.seq, 2)
    assert.equal(tail.truncated, true)
    assert.equal(tail.cursor, 4)
  })

  it('rejects unknown workspaces and sessions with stable codes', async () => {
    await assert.rejects(client().listSessions('missing'), (error: unknown) => {
      assert.ok(error instanceof RemoteProtocolError)
      assert.equal(error.code, 'workspace/not-found')
      return true
    })
    await assert.rejects(client().snapshotSession('missing'), (error: unknown) => {
      assert.ok(error instanceof RemoteProtocolError)
      assert.equal(error.code, 'session/not-found')
      return true
    })
  })

  it('streams the missing suffix from a cursor', async () => {
    const frames: SessionStreamFrame[] = []
    const controller = new AbortController()
    for await (const frame of client().followSession('session-alpha', 2, controller.signal)) {
      frames.push(frame)
    }
    assert.equal(frames[0]?.type, 'ready')
    assert.deepEqual(frames.filter(frame => frame.type === 'event').map(frame => frame.type === 'event' ? frame.event.seq : -1), [2, 3])
  })

  it('delivers appended events to an open stream', async () => {
    const live = new FakeRemoteHost({ token: TOKEN, holdStreamMs: 2_000 })
    const address = await live.start()
    try {
      const controller = new AbortController()
      const task = (async (): Promise<number[]> => {
        const seqs: number[] = []
        for await (const frame of new RemoteAgentClient({
          baseUrl: address.baseUrl,
          token: TOKEN,
        }).followSession('session-alpha', 0, controller.signal)) {
          if (frame.type === 'event') seqs.push(frame.event.seq)
          if (seqs.length === 5) {
            controller.abort()
            break
          }
        }
        return seqs
      })()
      await new Promise(resolve => setTimeout(resolve, 50))
      live.appendEvent('session-alpha', { seq: 4, type: 'test/append', time: Date.now(), data: {} })
      const seqs = await task
      assert.deepEqual(seqs, [0, 1, 2, 3, 4])
    } finally {
      await live.stop()
    }
  })

  it('surfaces authentication and protocol failures', async () => {
    await assert.rejects(client('wrong').health(), (error: unknown) => {
      assert.ok(error instanceof RemoteProtocolError)
      assert.equal(error.code, 'auth/invalid')
      return true
    })

    const incompatible = new FakeRemoteHost({ token: TOKEN, protocolVersion: 2 })
    const address = await incompatible.start()
    try {
      await assert.rejects(
        new RemoteAgentClient({ baseUrl: address.baseUrl, token: TOKEN }).health(),
        (error: unknown) => {
          assert.ok(error instanceof RemoteProtocolError)
          assert.equal(error.code, 'protocol/version-mismatch')
          return true
        },
      )
    } finally {
      await incompatible.stop()
    }
  })
})

describe('cursor contract', () => {
  it('detects triplication and gaps before a consumer renders', () => {
    const cursor = new EventCursor(10)
    assert.equal(cursor.accept({ seq: 10 }), 'applied')
    assert.equal(cursor.accept({ seq: 10 }), 'duplicate')
    assert.equal(cursor.accept({ seq: 12 }), 'gap')
    assert.equal(cursor.next, 11)
  })
})
