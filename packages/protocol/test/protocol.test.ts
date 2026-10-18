import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'

import {
  AGENT_ROUTES,
  EventCursor,
  PROTOCOL_VERSION,
  RemoteAgentClient,
  RemoteProtocolError,
  matchAgentRoute,
  negotiateProtocol,
  parseSseStream,
  sessionAssistantEventsPath,
  sessionEventsPath,
  sessionPath,
  workspaceSessionsPath,
} from '../src/index.ts'

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

function readAuth(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  return header?.startsWith('Bearer ') === true ? header.slice('Bearer '.length) : undefined
}

describe('version negotiation', () => {
  it('accepts the current revision', () => {
    assert.deepEqual(negotiateProtocol(PROTOCOL_VERSION), { ok: true, version: PROTOCOL_VERSION })
  })

  it('rejects a missing, malformed, or unknown revision', () => {
    assert.equal(negotiateProtocol(undefined).ok, false)
    assert.equal(negotiateProtocol(Number.NaN).ok, false)
    assert.equal(negotiateProtocol(PROTOCOL_VERSION + 1).ok, false)
    const unsupported = negotiateProtocol(PROTOCOL_VERSION + 1)
    assert.equal(unsupported.ok, false)
    if (!unsupported.ok) {
      assert.equal(unsupported.reason, 'unsupported')
      assert.deepEqual(unsupported.supported, [PROTOCOL_VERSION])
    }
  })
})

describe('route table', () => {
  it('matches fixed routes', () => {
    assert.deepEqual(matchAgentRoute(AGENT_ROUTES.health), { kind: 'health' })
    assert.deepEqual(matchAgentRoute(AGENT_ROUTES.workspaces), { kind: 'workspaces' })
  })

  it('decodes session and workspace ids', () => {
    assert.deepEqual(matchAgentRoute(sessionPath('session-1')), { kind: 'session', sessionId: 'session-1' })
    assert.deepEqual(matchAgentRoute(sessionEventsPath('session-1', 3).split('?')[0] ?? ''), {
      kind: 'session-events',
      sessionId: 'session-1',
    })
    assert.deepEqual(matchAgentRoute(sessionAssistantEventsPath('session-1')), {
      kind: 'session-assistant-events',
      sessionId: 'session-1',
    })
    assert.deepEqual(matchAgentRoute(workspaceSessionsPath('workspace/a')), {
      kind: 'workspace-sessions',
      workspaceId: 'workspace/a',
    })
  })

  it('rejects unknown paths and malformed escapes', () => {
    assert.equal(matchAgentRoute('/dsh-remote-agent/api/v1/nope'), undefined)
    assert.equal(matchAgentRoute('/dsh-remote-agent/api/v1/sessions/%E0%A4%A'), undefined)
  })
})

describe('event cursor', () => {
  it('applies contiguous events and reports duplicates and gaps', () => {
    const cursor = new EventCursor(2)
    assert.equal(cursor.accept({ seq: 2 }), 'applied')
    assert.equal(cursor.next, 3)
    assert.equal(cursor.accept({ seq: 2 }), 'duplicate')
    assert.equal(cursor.accept({ seq: 5 }), 'gap')
    assert.equal(cursor.next, 3)
    cursor.reset(5)
    assert.equal(cursor.next, 5)
  })
})

describe('SSE parser', () => {
  it('dispatches events and ignores comments', async () => {
    const payload = ': hello\n\nevent: ready\ndata: {"a":1}\n\nid: 7\ndata: line1\ndata: line2\n\n'
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload))
        controller.close()
      },
    })
    const messages = []
    for await (const message of parseSseStream(stream)) messages.push(message)
    assert.deepEqual(messages, [
      { event: 'ready', data: '{"a":1}', id: undefined },
      { event: 'message', data: 'line1\nline2', id: '7' },
    ])
  })
})

describe('RemoteAgentClient', () => {
  let server: Server
  let baseUrl: string
  const token = 'test-token'

  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.headers[`x-dsh-remote-protocol`] === undefined) {
        json(res, 409, {
          ok: false,
          protocolVersion: PROTOCOL_VERSION,
          serverTime: new Date().toISOString(),
          error: { code: 'protocol/version-mismatch', message: 'missing version', retryable: false },
        })
        return
      }
      if (readAuth(req) !== token) {
        json(res, 401, {
          ok: false,
          protocolVersion: PROTOCOL_VERSION,
          serverTime: new Date().toISOString(),
          error: { code: 'auth/invalid', message: 'bad token', retryable: false },
        })
        return
      }
      if (url.pathname === AGENT_ROUTES.health) {
        json(res, 200, {
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          serverTime: new Date().toISOString(),
          data: {
            hostId: 'host-a',
            hostname: 'remote',
            platform: 'linux',
            arch: 'arm64',
            dshVersion: '0.2.1-rc.2',
            agentVersion: '0.1.0',
            home: '/home/user',
            startedAt: new Date().toISOString(),
            protocolVersion: PROTOCOL_VERSION,
            capabilities: ['health', 'workspace.list'],
            workspaceCount: 1,
          },
        })
        return
      }
      if (url.pathname === AGENT_ROUTES.workspaces) {
        json(res, 200, {
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          serverTime: new Date().toISOString(),
          data: {
            workspaces: [{
              workspaceId: 'w1',
              path: '/srv/project',
              title: 'project',
              sessionIds: ['s1'],
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
            }],
          },
        })
        return
      }
      if (url.pathname === sessionEventsPath('s1').split('?')[0]) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(': hi\n\n')
        res.write(`event: ready\ndata: ${JSON.stringify({ type: 'ready', hostId: 'host-a', sessionId: 's1', cursor: 0, live: true })}\n\n`)
        res.write(`event: event\ndata: ${JSON.stringify({ type: 'event', cursor: 1, event: { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } } })}\n\n`)
        res.end()
        return
      }
      json(res, 404, {
        ok: false,
        protocolVersion: PROTOCOL_VERSION,
        serverTime: new Date().toISOString(),
        error: { code: 'route/not-found', message: 'not found', retryable: false },
      })
    })
    baseUrl = await listen(server)
  })

  after(async () => {
    await close(server)
  })

  it('fetches health and workspaces', async () => {
    const client = new RemoteAgentClient({ baseUrl, token, hostId: 'host-a' })
    const health = await client.health()
    assert.equal(health.hostId, 'host-a')
    assert.equal(health.workspaceCount, 1)
    const workspaces = await client.listWorkspaces()
    assert.equal(workspaces[0]?.workspaceId, 'w1')
  })

  it('surfaces stable auth errors', async () => {
    const client = new RemoteAgentClient({ baseUrl, token: 'wrong' })
    await assert.rejects(client.health(), (error: unknown) => {
      assert.ok(error instanceof RemoteProtocolError)
      assert.equal(error.code, 'auth/invalid')
      assert.equal(error.httpStatus, 401)
      return true
    })
  })

  it('streams session frames with cursors', async () => {
    const client = new RemoteAgentClient({ baseUrl, token })
    const controller = new AbortController()
    const frames = []
    for await (const frame of client.followSession('s1', 0, controller.signal)) frames.push(frame)
    assert.equal(frames.length, 2)
    assert.equal(frames[0]?.type, 'ready')
    assert.equal(frames[1]?.type, 'event')
  })
})
