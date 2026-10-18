/**
 * HTTP/SSE adapter for the remote agent.
 *
 * Security posture: the route is a plain named `ctx.webServer` route, so it
 * is not protected by the browser `/api` authentication fence. It therefore
 * enforces its own loopback peer check, bearer token, protocol negotiation,
 * method allowlist, and no-store headers. It never accepts a request body.
 *
 * @module dsh-remote-agent/http
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  AGENT_API_PREFIX,
  HEADER_AGENT_VERSION,
  HEADER_HOST_ID,
  HEADER_PROTOCOL_VERSION,
  HEADER_REQUEST_ID,
  HEADER_SERVER_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  RemoteProtocolError,
  matchAgentRoute,
  negotiateProtocol,
  parseCursorQuery,
  parseProtocolHeader,
  type ApiFailure,
  type ApiSuccess,
  type SessionStreamFrame,
} from '@dsh-remote/protocol'
import { parseBearer, tokensEqual } from './auth.ts'
import type { RemoteAgentService } from './service.ts'
import { AGENT_VERSION } from './version.ts'

/** Header carrying the client's protocol revision. */
const CLIENT_PROTOCOL_HEADER = HEADER_PROTOCOL_VERSION

/** Register the agent prefix route and return its disposer. */
export function registerAgentRoutes(ctx: Context, service: RemoteAgentService): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: AGENT_API_PREFIX,
    handler: (req, res) => handleAgentRequest(ctx, service, req, res),
  })
}

async function handleAgentRequest(
  ctx: Context,
  service: RemoteAgentService,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestId = firstHeader(req.headers[HEADER_REQUEST_ID]) ?? randomUUID()
  res.setHeader(HEADER_SERVER_PROTOCOL_VERSION, String(PROTOCOL_VERSION))
  res.setHeader(HEADER_AGENT_VERSION, AGENT_VERSION)
  res.setHeader(HEADER_REQUEST_ID, requestId)
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')

  try {
    if (!service.admitsPeer(req.socket.remoteAddress)) {
      throw new RemoteProtocolError({
        code: 'auth/forbidden',
        message: 'the remote agent only accepts loopback peers',
      })
    }

    const presented = parseBearer(req.headers.authorization)
    if (presented === undefined) {
      throw new RemoteProtocolError({
        code: 'auth/missing',
        message: 'missing bearer token',
      })
    }
    if (!tokensEqual(service.token, presented)) {
      throw new RemoteProtocolError({
        code: 'auth/invalid',
        message: 'invalid bearer token',
      })
    }

    const negotiation = negotiateProtocol(parseProtocolHeader(firstHeader(req.headers[CLIENT_PROTOCOL_HEADER])))
    if (!negotiation.ok) {
      throw new RemoteProtocolError({
        code: 'protocol/version-mismatch',
        message: `unsupported protocol revision (${negotiation.reason}); this agent speaks ${negotiation.serverVersion}`,
        details: {
          clientVersion: negotiation.clientVersion ?? null,
          serverVersion: negotiation.serverVersion,
          supported: negotiation.supported,
        },
        httpStatus: 409,
      })
    }

    if (req.method !== 'GET') {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: 'only GET is supported',
        httpStatus: 405,
      })
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = matchAgentRoute(url.pathname)
    if (route === undefined) {
      throw new RemoteProtocolError({
        code: 'route/not-found',
        message: `no route for ${url.pathname}`,
      })
    }

    const hostId = parseHostId(req)
    switch (route.kind) {
      case 'health':
      case 'host':
        sendJson(res, service.hostInfo(hostId))
        return
      case 'workspaces':
        sendJson(res, service.listWorkspaces())
        return
      case 'sessions':
        sendJson(res, await service.listSessions())
        return
      case 'workspace-sessions':
        sendJson(res, await service.listSessions(route.workspaceId))
        return
      case 'session': {
        const limit = parseLimit(url.searchParams.get('limit'), service.config.maxSnapshotEvents)
        sendJson(res, await service.snapshotSession(hostId, route.sessionId, limit))
        return
      }
      case 'session-events': {
        let cursor: number
        try {
          cursor = parseCursorQuery(url.searchParams.get('cursor'), 0)
        } catch (error) {
          throw new RemoteProtocolError({
            code: 'request/invalid',
            message: error instanceof Error ? error.message : 'invalid cursor',
          })
        }
        await streamSession(ctx, service, req, res, hostId, route.sessionId, cursor)
        return
      }
      case 'web-url':
        sendJson(res, service.webUrl())
        return
    }
  } catch (error) {
    if (res.headersSent) {
      writeStreamEnd(res, 'error')
      ctx.logger.warn('dsh-remote-agent: request %s failed after headers: %s', requestId, String(error))
      return
    }
    if (error instanceof RemoteProtocolError) {
      sendFailure(res, error)
      return
    }
    ctx.logger.warn('dsh-remote-agent: request %s failed: %s', requestId, String(error))
    sendFailure(res, new RemoteProtocolError({
      code: 'internal',
      message: 'remote agent request failed',
    }))
  }
}

async function streamSession(
  ctx: Context,
  service: RemoteAgentService,
  req: IncomingMessage,
  res: ServerResponse,
  hostId: string,
  sessionId: string,
  cursor: number,
): Promise<void> {
  // Validate before committing SSE headers while the failure can still be a
  // normal JSON envelope with a meaningful status code.
  service.assertCanFollow(sessionId, cursor)

  const controller = new AbortController()
  const onClose = (): void => controller.abort()
  req.on('close', onClose)

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.flushHeaders?.()
  res.write('retry: 5000\n\n')

  try {
    for await (const frame of service.followSession(hostId, sessionId, cursor, controller.signal)) {
      if (res.writableEnded) break
      writeStreamFrame(res, frame)
      if (frame.type === 'end') break
    }
    res.end()
  } catch (error) {
    ctx.logger.warn('dsh-remote-agent: session stream %s failed: %s', sessionId, String(error))
    writeStreamEnd(res, 'error')
    res.end()
  } finally {
    req.off('close', onClose)
    controller.abort()
  }
}

function sendJson(res: ServerResponse, data: unknown): void {
  const body: ApiSuccess<unknown> = {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    serverTime: new Date().toISOString(),
    data,
  }
  res.statusCode = 200
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function sendFailure(res: ServerResponse, error: RemoteProtocolError): void {
  const body: ApiFailure = {
    ok: false,
    protocolVersion: PROTOCOL_VERSION,
    serverTime: new Date().toISOString(),
    error: error.toFailure(),
  }
  res.statusCode = error.httpStatus
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function writeStreamFrame(res: ServerResponse, frame: SessionStreamFrame): void {
  res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
}

function writeStreamEnd(res: ServerResponse, reason: 'error' | 'server-shutdown'): void {
  if (res.writableEnded) return
  try {
    res.write(`event: end\ndata: ${JSON.stringify({ type: 'end', cursor: 0, reason })}\n\n`)
  } catch {
    // The peer is already gone; there is nobody to notify.
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function parseHostId(req: IncomingMessage): string {
  const raw = firstHeader(req.headers[HEADER_HOST_ID])
  if (raw === undefined || raw.trim() === '') return 'local'
  const hostId = raw.trim()
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(hostId)) {
    throw new RemoteProtocolError({
      code: 'request/invalid',
      message: 'invalid host id header',
      details: { hostId },
    })
  }
  return hostId
}

function parseLimit(raw: string | null, maximum: number): number | undefined {
  if (raw === null || raw === '') return undefined
  if (!/^\d+$/u.test(raw)) {
    throw new RemoteProtocolError({
      code: 'request/invalid',
      message: `invalid limit: ${JSON.stringify(raw)}`,
    })
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RemoteProtocolError({
      code: 'request/invalid',
      message: `limit must be between 1 and ${maximum}`,
      details: { limit: raw, maximum },
    })
  }
  return value
}

export { AGENT_VERSION }
