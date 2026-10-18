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
import {
  HOST_API_PATH,
  type HostApiEndpoint,
  type HostApiPayloads,
  type HostApiRequest,
  type HostApiResult,
  type HostApiValues,
} from './contract.ts'

/** Register the route; returns its asynchronous disposer. */
export function registerHostApi(ctx: Context, service: RemoteHostsService): () => Promise<void> {
  return ctx.connection.fetch.register({
    path: HOST_API_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => handleHostApi(service, request),
  })
}

async function handleHostApi(service: RemoteHostsService, request: Request): Promise<Response> {
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
    const value = await dispatch(service, body.endpoint, body.payload)
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
  service: RemoteHostsService,
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
    case 'host/workspaces':
      return { workspaces: await service.workspaces(requireStringField(payload, 'hostId')) }
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
    case 'host/web-url':
      return service.webUrl(requireStringField(payload, 'hostId'))
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
