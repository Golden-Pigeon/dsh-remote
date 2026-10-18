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
import type { RemoteMirrorService } from './mirror/service.ts'

type JsonObject = Record<string, JsonValue>

const renderJson = (_args: unknown, value: unknown): { type: 'text'; text: string }[] => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
]

/** Strip class/prototype identity so tool output matches its JSON-schema type. */
function toJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

/** Register the remote-development tool family. */
export function registerRemoteTools(ctx: Context, service: RemoteHostsService, mirrors?: RemoteMirrorService): void {
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
    name: 'remote_host_provision',
    description: 'Force a fresh remote installation/restart of dsh-remote-agent and dsh web, then reconnect. Use this to repair a broken host or update an old agent.',
    parameters: {
      hostId: { type: 'string', required: true, description: 'Registered host id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { host: { type: 'object', additionalProperties: true, required: true } },
      },
      render: renderJson,
    },
    async execute(args) {
      return { host: toJsonObject(await service.provision(args.hostId)) }
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
    name: 'remote_workspace_add',
    description: 'Register an existing remote directory as a workspace on a connected remote DSH host. Then create a session in it with remote_session_create.',
    parameters: {
      hostId: { type: 'string', required: true, description: 'Connected remote host id.' },
      path: { type: 'string', required: true, description: 'Absolute remote directory path.' },
      title: { type: 'string', description: 'Optional display title.' },
      hidden: {
        type: 'boolean',
        description: 'Test/debug only: keep this remote workspace out of local sidebar surfaces. Not a Settings UI option.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workspace: { type: 'object', additionalProperties: true, required: true },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      const workspace = await service.createWorkspace(args.hostId, {
        path: args.path,
        ...args.title === undefined ? {} : { title: args.title },
      })
      if (args.hidden === true) {
        if (mirrors === undefined) throw new Error('session mirroring is disabled')
        await mirrors.setWorkspaceHidden(args.hostId, workspace.workspaceId, workspace.path, workspace.title, true)
      }
      return { workspace: toJsonObject(workspace) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'remote_workspace_hide',
    description: 'Test/debug only: hide or show one remote workspace in local sidebar surfaces. Hidden workspaces remain on the remote host and are not exposed as a Settings UI control.',
    parameters: {
      hostId: { type: 'string', required: true, description: 'Connected remote host id.' },
      workspaceId: { type: 'string', required: true, description: 'Remote workspace id.' },
      hidden: { type: 'boolean', description: 'True to hide (default), false to show again.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hidden: { type: 'boolean', required: true },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      if (mirrors === undefined) throw new Error('session mirroring is disabled')
      const hidden = args.hidden !== false
      const workspaces = await service.workspaces(args.hostId)
      const workspace = workspaces.find(item => item.workspaceId === args.workspaceId)
      if (workspace === undefined) throw new Error(`unknown remote workspace ${args.workspaceId}`)
      await mirrors.setWorkspaceHidden(args.hostId, args.workspaceId, workspace.path, workspace.title, hidden)
      return { hidden }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'remote_workspace_forget',
    description: 'Test/debug only: forget a local mirror workspace, archiving its local Sessions. Use when a test workspace was already removed remotely and its local row must be cleaned.',
    parameters: {
      hostId: { type: 'string', required: true, description: 'Connected remote host id.' },
      remoteWorkspaceId: { type: 'string', description: 'Remote workspace id, when it still exists.' },
      localWorkspaceId: { type: 'string', description: 'Local mirror workspace id, for stale records.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          forgotten: { type: 'boolean', required: true },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      if (mirrors === undefined) throw new Error('session mirroring is disabled')
      if (args.remoteWorkspaceId === undefined && args.localWorkspaceId === undefined) {
        throw new Error('provide remoteWorkspaceId or localWorkspaceId')
      }
      return { forgotten: await mirrors.forgetWorkspace(args.hostId, args.remoteWorkspaceId, args.localWorkspaceId) }
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
    name: 'remote_session_create',
    description: 'Create a session on a connected remote DSH host, either in an existing workspace or an explicit remote directory. This is a write operation on the remote host.',
    parameters: {
      hostId: { type: 'string', required: true, description: 'Connected remote host id.' },
      workspaceId: { type: 'string', description: 'Existing remote workspace id.' },
      cwd: { type: 'string', description: 'Remote directory for an ungrouped session; exclusive with workspaceId.' },
      agentPreset: { type: 'string', description: 'Optional remote agent preset.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          agentPreset: { type: 'string' },
        },
      },
      render: renderJson,
    },
    async execute(args) {
      return service.createSession(args.hostId, {
        ...args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId },
        ...args.cwd === undefined ? {} : { cwd: args.cwd },
        ...args.agentPreset === undefined ? {} : { agentPreset: args.agentPreset },
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'remote_session_prompt',
    description: 'Send a user prompt to a remote DSH session. The remote model runs on the remote host; the local model key can be proxied through the local credential proxy. This is a write operation.',
    parameters: {
      hostId: { type: 'string', required: true, description: 'Connected remote host id.' },
      sessionId: { type: 'string', required: true, description: 'Remote session id.' },
      text: { type: 'string', required: true, description: 'Prompt text.' },
      mode: { type: 'string', enum: ['queue', 'steer'], description: 'Delivery mode (default queue).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { accepted: { type: 'boolean', required: true } },
      },
      render: renderJson,
    },
    async execute(args) {
      return service.promptSession(args.hostId, args.sessionId, args.text, args.mode)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'remote_session_cancel',
    description: 'Cancel the active turn of a remote DSH session.',
    parameters: {
      hostId: { type: 'string', required: true, description: 'Connected remote host id.' },
      sessionId: { type: 'string', required: true, description: 'Remote session id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { accepted: { type: 'boolean', required: true } },
      },
      render: renderJson,
    },
    async execute(args) {
      return service.cancelSession(args.hostId, args.sessionId)
    },
  }))

}
