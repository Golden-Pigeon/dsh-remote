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
import type { ApprovalOutcome } from '@dsh-remote/protocol'
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
  type PromptContentPart,
  type PromptSessionRequest,
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

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = matchAgentRoute(url.pathname)
    if (route === undefined) {
      throw new RemoteProtocolError({
        code: 'route/not-found',
        message: `no route for ${url.pathname}`,
      })
    }
    const method = req.method ?? 'GET'

    // Write routes. Everything else is read-only GET.
    if (method === 'POST') {
      const body = await readJsonBody(req, route.kind === 'session-prompt' ? 12 * 1024 * 1024 : 256 * 1024)
      switch (route.kind) {
        case 'workspaces':
          sendJson(res, await service.createWorkspace(asWorkspaceRequest(body)))
          return
        case 'sessions':
          sendJson(res, await service.createSession(asCreateRequest(body)))
          return
        case 'session-model':
          sendJson(res, await service.selectModel(route.sessionId, asSelectModelRequest(body)))
          return
        case 'session-sandbox':
          sendJson(res, await service.setSandboxMode(route.sessionId, asSandboxModeRequest(body)))
          return
        case 'session-prompt':
          sendJson(res, await service.promptSession(route.sessionId, asPromptRequest(body)))
          return
        case 'session-cancel':
          sendJson(res, service.cancelSession(route.sessionId))
          return
        case 'approval-answer':
          sendJson(res, asApprovalAnswer(body, service))
          return
        default:
          throw new RemoteProtocolError({
            code: 'request/invalid',
            message: `${route.kind} does not accept POST`,
            httpStatus: 405,
          })
      }
    }
    if (method !== 'GET') {
      throw new RemoteProtocolError({
        code: 'request/invalid',
        message: 'unsupported method',
        httpStatus: 405,
      })
    }

    if (route.kind === 'approval-events') {
      streamApprovals(service, req, res)
      return
    }
    if (route.kind === 'session-assistant-events') {
      await streamAssistant(ctx, service, req, res, route.sessionId)
      return
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
      case 'session-prompt':
      case 'session-cancel':
      case 'approval-answer':
        throw new RemoteProtocolError({ code: 'request/invalid', message: 'POST is required', httpStatus: 405 })
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

async function streamAssistant(
  ctx: Context,
  service: RemoteAgentService,
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  service.assertLiveSession(sessionId)
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
    for await (const frame of service.followAssistantFrames(sessionId, controller.signal)) {
      if (res.writableEnded) break
      res.write(`event: assistant\ndata: ${JSON.stringify(frame)}\n\n`)
    }
    res.end()
  } catch (error) {
    ctx.logger.warn('dsh-remote-agent: assistant stream %s failed: %s', sessionId, String(error))
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

async function readJsonBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxBytes) {
      throw new RemoteProtocolError({ code: 'request/too-large', message: `request body exceeds ${Math.round(maxBytes / 1024)} KiB` })
    }
    chunks.push(buffer)
  }
  if (bytes === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    throw new RemoteProtocolError({ code: 'request/invalid', message: 'request body must be JSON', cause: error })
  }
}

function asApprovalAnswer(value: unknown, service: RemoteAgentService): { accepted: true } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RemoteProtocolError({ code: 'request/invalid', message: 'body must be a JSON object' })
  }
  const body = value as Record<string, unknown>
  if (typeof body.id !== 'string' || body.id === '') {
    throw new RemoteProtocolError({ code: 'request/invalid', message: 'id must be a non-empty string' })
  }
  const outcomes: readonly ApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']
  if (typeof body.outcome !== 'string' || !outcomes.includes(body.outcome as ApprovalOutcome)) {
    throw new RemoteProtocolError({ code: 'request/invalid', message: 'outcome is invalid' })
  }
  return service.answerApproval(body.id, body.outcome as ApprovalOutcome)
}

function asWorkspaceRequest(value: unknown): { path: string; title?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RemoteProtocolError({ code: 'request/invalid', message: 'body must be a JSON object' })
  }
  const body = value as Record<string, unknown>
  if (typeof body.path !== 'string' || body.path.trim() === '') {
    throw new RemoteProtocolError({ code: 'request/invalid', message: 'path must be a non-empty string' })
  }
  if (body.title !== undefined && typeof body.title !== 'string') {
    throw new RemoteProtocolError({ code: 'request/invalid', message: 'title must be a string' })
  }
  return { path: body.path.trim(), ...body.title === undefined ? {} : { title: body.title } }
}

function asCreateRequest(value: unknown): { workspaceId?: string; cwd?: string; agentPreset?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RemoteProtocolError({ code: 'request/invalid', message: 'body must be a JSON object' })
  }
  const body = value as Record<string, unknown>
  const result: { workspaceId?: string; cwd?: string; agentPreset?: string } = {}
  for (const key of ['workspaceId', 'cwd', 'agentPreset'] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'string') {
        throw new RemoteProtocolError({ code: 'request/invalid', message: `${key} must be a string` })
      }
      result[key] = body[key]
    }
  }
  return result
}

function asSandboxModeRequest(value: unknown): 'read-only' | 'workspace-write' | 'danger-full-access' {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RemoteProtocolError({ code: 'request/invalid', message: 'body must be a JSON object' })
  }
  const mode = (value as Record<string, unknown>).mode
  if (mode !== 'read-only' && mode !== 'workspace-write' && mode !== 'danger-full-access') {
    throw new RemoteProtocolError({ code: 'request/invalid', message: 'mode is invalid' })
  }
  return mode
}

function asSelectModelRequest(value: unknown): { provider: string; model: string; reasoningEffort?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RemoteProtocolError({ code: 'request/invalid', message: 'body must be a JSON object' })
  }
  const body = value as Record<string, unknown>
  for (const key of ['provider', 'model'] as const) {
    if (typeof body[key] !== 'string' || body[key].trim() === '') {
      throw new RemoteProtocolError({ code: 'request/invalid', message: `${key} must be a non-empty string` })
    }
  }
  if (body.reasoningEffort !== undefined && typeof body.reasoningEffort !== 'string') {
    throw new RemoteProtocolError({ code: 'request/invalid', message: 'reasoningEffort must be a string' })
  }
  return {
    provider: body.provider as string,
    model: body.model as string,
    ...typeof body.reasoningEffort === 'string' ? { reasoningEffort: body.reasoningEffort } : {},
  }
}

function inferImageMediaType(data: string): string | undefined {
  const head = Buffer.from(data.slice(0, 64), 'base64')
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 6 && (head.subarray(0, 6).toString('ascii') === 'GIF87a' || head.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif'
  if (head.length >= 12 && head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

function asPromptRequest(value: unknown): PromptSessionRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RemoteProtocolError({ code: 'request/invalid', message: 'body must be a JSON object' })
  }
  const body = value as Record<string, unknown>
  const content = Array.isArray(body.content) ? body.content : undefined
  const hasImage = content?.some(part => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'image') === true
  if ((typeof body.text !== 'string' || body.text.trim() === '') && !hasImage) {
    throw new RemoteProtocolError({ code: 'request/invalid', message: 'text must be a non-empty string or content must include an image' })
  }
  if (body.mode !== undefined && body.mode !== 'queue' && body.mode !== 'steer') {
    throw new RemoteProtocolError({ code: 'request/invalid', message: 'mode must be queue or steer' })
  }
  for (const key of ['text', 'provider', 'model', 'reasoningEffort'] as const) {
    if (body[key] !== undefined && typeof body[key] !== 'string') {
      throw new RemoteProtocolError({ code: 'request/invalid', message: `${key} must be a string` })
    }
  }
  const parts: PromptContentPart[] = []
  for (const part of content ?? []) {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) {
      throw new RemoteProtocolError({ code: 'request/invalid', message: 'content parts must be objects' })
    }
    const record = part as Record<string, unknown>
    if (record.type === 'text') {
      if (typeof record.text !== 'string') throw new RemoteProtocolError({ code: 'request/invalid', message: 'text content part is invalid' })
      parts.push({ type: 'text', text: record.text })
      continue
    }
    if (record.type === 'image') {
      if (typeof record.data !== 'string') {
        throw new RemoteProtocolError({ code: 'request/invalid', message: 'image content part is invalid' })
      }
      const mediaType = typeof record.mediaType === 'string'
        ? record.mediaType
        : inferImageMediaType(record.data)
      if (mediaType === undefined) {
        throw new RemoteProtocolError({ code: 'request/invalid', message: 'image content part is invalid' })
      }
      parts.push({
        type: 'image',
        data: record.data,
        mediaType,
        ...typeof record.name === 'string' ? { name: record.name } : {},
      })
      continue
    }
    throw new RemoteProtocolError({ code: 'request/invalid', message: 'unsupported content part' })
  }
  return {
    text: typeof body.text === 'string' ? body.text : '',
    ...parts.length === 0 ? {} : { content: parts },
    ...body.mode === undefined ? {} : { mode: body.mode },
    ...typeof body.provider === 'string' ? { provider: body.provider } : {},
    ...typeof body.model === 'string' ? { model: body.model } : {},
    ...typeof body.reasoningEffort === 'string' ? { reasoningEffort: body.reasoningEffort } : {},
  }
}

function streamApprovals(service: RemoteAgentService, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const write = (event: string, data: unknown): void => {
    if (res.writableEnded) return
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  write('ready', { type: 'ready' })
  for (const request of service.approvalRequests()) write('request', { type: 'request', request })
  const off = service.onApprovalRequest(request => {
    write('request', { type: 'request', request })
  })
  const heartbeat = setInterval(() => { write('heartbeat', {}) }, 15_000)
  const close = (): void => {
    clearInterval(heartbeat)
    off()
    if (!res.writableEnded) res.end()
  }
  req.on('close', close)
  req.on('error', close)
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
