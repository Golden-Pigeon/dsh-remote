/**
 * Authenticated host API over Connection's exact Fetch route.
 *
 * The route is mounted under `/api`, so Connection owns the Host/Origin fence,
 * browser authentication, owner-Peer check, and body limits. This module only
 * validates the endpoint/payload, dispatches to the service, and shapes the
 * JSON result.
 *
 * @module dsh-remote-local/host-api/handler
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { LocalError, asLocalError } from '../errors.ts'
import type { RemoteHostsService } from '../service.ts'
import type { RemoteMirrorService } from '../mirror/service.ts'
import { listRemoteDirectories } from '../remote/directory.ts'
import { listLocalDirectories } from '../remote/local-directory.ts'
import {
  HOST_API_PATH,
  type HostApiEndpoint,
  type HostApiPayloads,
  type HostApiRequest,
  type HostApiResult,
  type HostApiValues,
} from './contract.ts'

/** Register the route; returns its asynchronous disposer. */
export function registerHostApi(
  ctx: Context,
  service: RemoteHostsService,
  mirrors?: RemoteMirrorService,
): () => Promise<void> {
  return ctx.connection.fetch.register({
    path: HOST_API_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => handleHostApi(ctx, service, mirrors, request),
  })
}

async function handleHostApi(
  ctx: Context,
  service: RemoteHostsService,
  mirrors: RemoteMirrorService | undefined,
  request: Request,
): Promise<Response> {
  let body: HostApiRequest
  try {
    body = await request.json() as HostApiRequest
  } catch (error) {
    return jsonResult({
      ok: false,
      error: {
        code: 'request/invalid',
        message: 'request body must be JSON',
        details: {},
      },
    })
  }

  if (typeof body !== 'object' || body === null || typeof body.endpoint !== 'string') {
    return jsonResult({
      ok: false,
      error: { code: 'request/invalid', message: 'request.endpoint must be a string', details: {} },
    })
  }

  try {
    const value = await dispatch(ctx, service, mirrors, body.endpoint, body.payload)
    return jsonResult({ ok: true, value })
  } catch (error) {
    const failure = asLocalError(error)
    return jsonResult({
      ok: false,
      error: {
        code: failure.code,
        message: failure.message,
        details: failure.details,
      },
    })
  }
}

async function dispatch(
  ctx: Context,
  service: RemoteHostsService,
  mirrors: RemoteMirrorService | undefined,
  endpoint: string,
  payload: unknown,
): Promise<HostApiValues[HostApiEndpoint]> {
  switch (endpoint as HostApiEndpoint) {
    case 'state':
      return service.state()
    case 'target/validate':
      return service.validateTarget(requireStringField(payload, 'sshTarget'))
    case 'host/add': {
      const body = requireRecord(payload)
      return service.add({
        sshTarget: requireStringField(body, 'sshTarget'),
        ...optionalStringField(body, 'label') === undefined ? {} : { label: optionalStringField(body, 'label') },
        ...optionalStringField(body, 'token') === undefined ? {} : { token: optionalStringField(body, 'token') },
        ...optionalNumberField(body, 'remoteAgentPort') === undefined
          ? {}
          : { remoteAgentPort: optionalNumberField(body, 'remoteAgentPort') },
        ...optionalBooleanField(body, 'autoConnect') === undefined
          ? {}
          : { autoConnect: optionalBooleanField(body, 'autoConnect') },
      })
    }
    case 'host/remove': {
      const body = requireRecord(payload)
      await service.remove(requireStringField(body, 'hostId'))
      return { removed: true }
    }
    case 'host/connect':
      return service.connect(requireStringField(payload, 'hostId'))
    case 'host/disconnect':
      return service.disconnect(requireStringField(payload, 'hostId'))
    case 'host/refresh':
      return service.refresh(requireStringField(payload, 'hostId'))
    case 'host/provision':
      return service.provision(requireStringField(payload, 'hostId'))
    case 'host/workspaces': {
      const hostId = requireStringField(payload, 'hostId')
      const workspaces = await service.workspaces(hostId)
      return {
        workspaces: workspaces
          .filter(workspace => mirrors?.isTestHidden(workspace.workspaceId, workspace.path) !== true)
          .map(workspace => {
            const localWorkspaceId = mirrors?.localWorkspaceId(hostId, workspace.workspaceId)
            return localWorkspaceId === undefined ? workspace : { ...workspace, localWorkspaceId }
          }),
      }
    }
    case 'host/workspace/create': {
      const body = requireRecord(payload)
      return service.createWorkspace(requireStringField(body, 'hostId'), {
        path: requireStringField(body, 'path'),
        ...optionalStringField(body, 'title') === undefined ? {} : { title: optionalStringField(body, 'title') },
      })
    }
    case 'host/directory/list': {
      const body = requireRecord(payload)
      return listRemoteDirectories(service, requireStringField(body, 'hostId'), optionalStringField(body, 'path') ?? '~')
    }
    case 'local/directory/list': {
      const body = requireRecord(payload)
      return listLocalDirectories(optionalStringField(body, 'path'))
    }
    case 'local/workspace/create': {
      const body = requireRecord(payload)
      const registry = ctx.get('workspaceRegistry') as
        | { create(path: string, title?: string): Promise<{ id: string }> }
        | undefined
      if (registry === undefined) throw new LocalError('agent/unavailable', 'workspace registry is unavailable')
      const workspace = await registry.create(
        requireStringField(body, 'path'),
        optionalStringField(body, 'title'),
      )
      return { workspaceId: String(workspace.id) }
    }
    case 'host/sessions': {
      const body = requireRecord(payload)
      return service.sessions(
        requireStringField(body, 'hostId'),
        optionalStringField(body, 'workspaceId'),
      )
    }
    case 'host/session': {
      const body = requireRecord(payload)
      return service.snapshot(
        requireStringField(body, 'hostId'),
        requireStringField(body, 'sessionId'),
        optionalNumberField(body, 'limit'),
      )
    }
    case 'host/session/create': {
      const body = requireRecord(payload)
      const hostId = requireStringField(body, 'hostId')
      const created = await service.createSession(hostId, {
        ...optionalStringField(body, 'workspaceId') === undefined
          ? {}
          : { workspaceId: optionalStringField(body, 'workspaceId') },
        ...optionalStringField(body, 'cwd') === undefined ? {} : { cwd: optionalStringField(body, 'cwd') },
        ...optionalStringField(body, 'agentPreset') === undefined
          ? {}
          : { agentPreset: optionalStringField(body, 'agentPreset') },
      })
      const localSessionId = await mirrors?.ensureRemoteSession(hostId, created.sessionId)
      return { ...created, ...localSessionId === undefined ? {} : { localSessionId } }
    }
    case 'host/session/prompt': {
      const body = requireRecord(payload)
      const mode = optionalStringField(body, 'mode')
      if (mode !== undefined && mode !== 'queue' && mode !== 'steer') {
        throw new LocalError('request/invalid', 'mode must be queue or steer')
      }
      const provider = optionalStringField(body, 'provider')
      const model = optionalStringField(body, 'model')
      const reasoningEffort = optionalStringField(body, 'reasoningEffort')
      return service.promptSession(
        requireStringField(body, 'hostId'),
        requireStringField(body, 'sessionId'),
        requireStringField(body, 'text'),
        mode,
        provider === undefined || model === undefined
          ? undefined
          : { provider, model, ...reasoningEffort === undefined ? {} : { reasoningEffort } },
      )
    }
    case 'host/session/cancel': {
      const body = requireRecord(payload)
      return service.cancelSession(
        requireStringField(body, 'hostId'),
        requireStringField(body, 'sessionId'),
      )
    }
    case 'host/web-url':
      return service.webUrl(requireStringField(payload, 'hostId'))
    case 'host/files/list':
    case 'host/files/read':
    case 'host/files/stat':
    case 'host/files/bytes': {
      const body = requireRecord(payload)
      const sessionId = requireStringField(body, 'sessionId')
      const path = requireStringField(body, 'path')
      const sessions = ctx.get('sessions')
      const session = sessions?.get(sessionId as never)
      const root = session?.header.cwd
      if (root === undefined || mirrors?.remoteFileContext(root) === undefined) return { mirrored: false }
      const files = ctx.get('workspaceFiles') as unknown as {
        list(scope: unknown, path: string, signal: AbortSignal): Promise<unknown>
        read(scope: unknown, path: string, range: unknown, signal: AbortSignal): Promise<unknown>
        readBytes(scope: unknown, path: string, options: unknown, signal: AbortSignal): Promise<unknown>
        stat(scope: unknown, path: string, signal: AbortSignal): Promise<unknown>
      } | undefined
      if (files === undefined) return { mirrored: false }
      const scope = { sessionId, workspaceRoot: root }
      const signal = new AbortController().signal
      if (endpoint === 'host/files/list') return { mirrored: true, value: await files.list(scope, path, signal) }
      if (endpoint === 'host/files/stat') return { mirrored: true, value: await files.stat(scope, path, signal) }
      if (endpoint === 'host/files/bytes') return { mirrored: true, value: await files.readBytes(scope, path, {
        range: {
          ...body.offset === undefined ? {} : { offset: body.offset },
          ...body.length === undefined ? {} : { length: body.length },
        },
      }, signal) }
      return { mirrored: true, value: await files.read(scope, path, {
        ...body.offset === undefined ? {} : { offset: body.offset },
        ...body.limit === undefined ? {} : { limit: body.limit },
      }, signal) }
    }
    default:
      throw new LocalError('request/invalid', `unknown remote-host endpoint: ${JSON.stringify(endpoint)}`)
  }
}

function jsonResult(result: HostApiResult<unknown>): Response {
  return Response.json(result, {
    status: 200,
    headers: { 'cache-control': 'no-store' },
  })
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LocalError('request/invalid', 'payload must be a JSON object')
  }
  return value as Record<string, unknown>
}

function requireStringField(value: unknown, field: string): string {
  const record = requireRecord(value)
  const fieldValue = record[field]
  if (typeof fieldValue !== 'string' || fieldValue.trim() === '') {
    throw new LocalError('request/invalid', `payload.${field} must be a non-empty string`)
  }
  return fieldValue.trim()
}

function optionalStringField(value: unknown, field: string): string | undefined {
  const record = requireRecord(value)
  const fieldValue = record[field]
  if (fieldValue === undefined || fieldValue === null) return undefined
  if (typeof fieldValue !== 'string') {
    throw new LocalError('request/invalid', `payload.${field} must be a string`)
  }
  return fieldValue
}

function optionalNumberField(value: unknown, field: string): number | undefined {
  const record = requireRecord(value)
  const fieldValue = record[field]
  if (fieldValue === undefined || fieldValue === null) return undefined
  if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) {
    throw new LocalError('request/invalid', `payload.${field} must be a number`)
  }
  return fieldValue
}

function optionalBooleanField(value: unknown, field: string): boolean | undefined {
  const record = requireRecord(value)
  const fieldValue = record[field]
  if (fieldValue === undefined || fieldValue === null) return undefined
  if (typeof fieldValue !== 'boolean') {
    throw new LocalError('request/invalid', `payload.${field} must be a boolean`)
  }
  return fieldValue
}
