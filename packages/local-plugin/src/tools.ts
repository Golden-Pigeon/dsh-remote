/**
 * Model-facing tools for remote development.
 *
 * These are deliberately thin wrappers over the same service the Settings
 * page uses. They let an agent add a host, inspect its status, and read remote
 * workspaces/sessions without a UI detour; secrets are never returned.
 *
 * @module dsh-remote-local/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@dsh-remote/protocol'
import type { RemoteHostsService } from './service.ts'

type JsonObject = Record<string, JsonValue>

const renderJson = (_args: unknown, value: unknown): { type: 'text'; text: string }[] => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
]

/** Strip class/prototype identity so tool output matches its JSON-schema type. */
function toJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

/** Register the remote-development tool family. */
export function registerRemoteTools(ctx: Context, service: RemoteHostsService): void {
  ctx.tools.register(defineTool({
    name: 'remote_hosts_list',
    description: 'List configured remote development hosts, their SSH destinations, connection phases, and remote host facts. Use this before connecting or listing remote workspaces.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          protocolVersion: { type: 'number', required: true },
          hosts: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      },
      render: renderJson,
    },
    async execute() {
      const state = service.state()
      return { protocolVersion: state.protocolVersion, hosts: state.hosts.map(toJsonObject) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'remote_host_add',
    description: 'Register an SSH host for remote development. The local plugin discovers the remote agent over SSH and opens a loopback SSH tunnel. The token is optional when discovery succeeds; never paste a token into chat unless you control it.',
    parameters: {
      sshTarget: {
        type: 'string',
        required: true,
        description: 'SSH destination such as user@host, host:2222, or ssh://user@host:22.',
      },
      label: { type: 'string', description: 'Display label; defaults to the hostname.' },
      token: { type: 'string', description: 'Optional remote agent bearer token. Prefer discovery.' },
      remoteAgentPort: { type: 'number', description: 'Optional remote agent port when discovery is unavailable.' },
      autoConnect: { type: 'boolean', description: 'Connect immediately (default true).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          host: { type: 'object', additionalProperties: true, required: true },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      return { host: toJsonObject(await service.add(args)) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'remote_host_connect',
    description: 'Connect, reconnect, or refresh one registered remote host. Waits for SSH discovery, the tunnel, and the remote agent health check to settle.',
    parameters: {
      hostId: { type: 'string', required: true, description: 'Host id returned by remote_hosts_list or remote_host_add.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          host: { type: 'object', additionalProperties: true, required: true },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      return { host: toJsonObject(await service.connect(args.hostId)) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'remote_workspaces_list',
    description: 'List workspaces registered on a connected remote DSH host. Use the returned workspaceId with remote_sessions_list.',
    parameters: {
      hostId: { type: 'string', required: true, description: 'Connected remote host id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspaces: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      return { workspaces: (await service.workspaces(args.hostId)).map(toJsonObject) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'remote_sessions_list',
    description: 'List sessions on a connected remote DSH host, optionally scoped to one workspace. Includes live/persisted state and event counts when available.',
    parameters: {
      hostId: { type: 'string', required: true, description: 'Connected remote host id.' },
      workspaceId: { type: 'string', description: 'Optional remote workspace id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const { sessions } = await service.sessions(args.hostId, args.workspaceId)
      return { sessions: sessions.map(toJsonObject) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'remote_session_snapshot',
    description: 'Read the newest page of one remote session event log. This is a read-only projection; no tool executes on the remote host.',
    parameters: {
      hostId: { type: 'string', required: true, description: 'Connected remote host id.' },
      sessionId: { type: 'string', required: true, description: 'Remote session id.' },
      limit: { type: 'number', description: 'Maximum events to return (default 500, capped by the agent).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          snapshot: { type: 'object', additionalProperties: true, required: true },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      return { snapshot: toJsonObject(await service.snapshot(args.hostId, args.sessionId, args.limit)) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'remote_web_url',
    description: 'Resolve the remote DSH Web UI URL through the host tunnel. Opening it gives the full remote UI for sessions that are not yet B-native in the local client.',
    parameters: {
      hostId: { type: 'string', required: true, description: 'Connected remote host id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      return service.webUrl(args.hostId)
    },
  }))
}
