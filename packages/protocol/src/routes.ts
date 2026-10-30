/**
 * Route table and path builder/parser shared by the agent and client.
 *
 * Keeping paths in one module makes a route rename a compile-time change on
 * both sides and prevents the client from hard-coding a path the agent does
 * not serve.
 *
 * @module @dsh-remote/protocol/routes
 */

import { AGENT_API_PREFIX } from './version.ts'

/** Fixed agent routes. */
export const AGENT_ROUTES = {
  health: `${AGENT_API_PREFIX}/health`,
  host: `${AGENT_API_PREFIX}/host`,
  workspaces: `${AGENT_API_PREFIX}/workspaces`,
  sessions: `${AGENT_API_PREFIX}/sessions`,
  webUrl: `${AGENT_API_PREFIX}/web-url`,
  approvalEvents: `${AGENT_API_PREFIX}/approvals/events`,
  approvalAnswer: `${AGENT_API_PREFIX}/approvals/answer`,
  fileStat: `${AGENT_API_PREFIX}/files/stat`,
  fileList: `${AGENT_API_PREFIX}/files/list`,
  fileRead: `${AGENT_API_PREFIX}/files/read`,
  fileBytes: `${AGENT_API_PREFIX}/files/bytes`,
  fileWatch: `${AGENT_API_PREFIX}/files/watch`,
  directories: `${AGENT_API_PREFIX}/directories`,
  terminals: `${AGENT_API_PREFIX}/terminals`,
} as const

/** One decoded agent route. */
export type AgentRoute =
  | { readonly kind: 'health' }
  | { readonly kind: 'host' }
  | { readonly kind: 'workspaces' }
  | { readonly kind: 'sessions' }
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'session-events'; readonly sessionId: string }
  | { readonly kind: 'session-assistant-events'; readonly sessionId: string }
  | { readonly kind: 'session-model'; readonly sessionId: string }
  | { readonly kind: 'session-sandbox'; readonly sessionId: string }
  | { readonly kind: 'session-prompt'; readonly sessionId: string }
  | { readonly kind: 'session-cancel'; readonly sessionId: string }
  | { readonly kind: 'workspace-sessions'; readonly workspaceId: string }
  | { readonly kind: 'web-url' }
  | { readonly kind: 'approval-events' }
  | { readonly kind: 'approval-answer' }
  | { readonly kind: 'file-stat' }
  | { readonly kind: 'file-list' }
  | { readonly kind: 'file-read' }
  | { readonly kind: 'file-bytes' }
  | { readonly kind: 'file-watch' }
  | { readonly kind: 'directory-list' }
  | { readonly kind: 'terminals' }
  | { readonly kind: 'terminal-attach'; readonly terminalId: string }
  | { readonly kind: 'terminal-input'; readonly terminalId: string }
  | { readonly kind: 'terminal-rename'; readonly terminalId: string }
  | { readonly kind: 'terminal-close'; readonly terminalId: string }

/** Path of the session list for one workspace. */
export function workspaceSessionsPath(workspaceId: string): string {
  return `${AGENT_API_PREFIX}/workspaces/${encodeURIComponent(workspaceId)}/sessions`
}

/** Path of one session snapshot. */
export function sessionPath(sessionId: string): string {
  return `${AGENT_API_PREFIX}/sessions/${encodeURIComponent(sessionId)}`
}

/** Path that accepts a model selection for one session. */
export function sessionModelPath(sessionId: string): string {
  return `${sessionPath(sessionId)}/model`
}

/** Path that accepts a sandbox mode for one session. */
export function sessionSandboxModePath(sessionId: string): string {
  return `${sessionPath(sessionId)}/sandbox`
}

/** Path that accepts a prompt for one session. */
export function sessionPromptPath(sessionId: string): string {
  return `${sessionPath(sessionId)}/prompt`
}

/** Path that cancels one session's active turn. */
export function sessionCancelPath(sessionId: string): string {
  return `${sessionPath(sessionId)}/cancel`
}

/** Path of one session's live event stream. */
export function sessionEventsPath(sessionId: string, cursor?: number): string {
  const base = `${sessionPath(sessionId)}/events`
  return cursor === undefined ? base : `${base}?cursor=${encodeURIComponent(String(cursor))}`
}

/** Path of one session's live Assistant stream. */
export function sessionAssistantEventsPath(sessionId: string): string {
  return `${sessionPath(sessionId)}/assistant-events`
}

/** Path for one remote file watch stream. */
export function fileWatchPath(path: string): string {
  return `${AGENT_ROUTES.fileWatch}?path=${encodeURIComponent(path)}`
}

/** Path for one remote directory picker listing. */
export function directoryListPath(path: string): string {
  return `${AGENT_ROUTES.directories}?path=${encodeURIComponent(path)}`
}

/** Path of one terminal attachment stream. */
export function terminalAttachPath(id: string): string {
  return `${AGENT_ROUTES.terminals}/${encodeURIComponent(id)}/attach`
}

/** Path that accepts terminal input or resize. */
export function terminalInputPath(id: string): string {
  return `${AGENT_ROUTES.terminals}/${encodeURIComponent(id)}/input`
}

/** Path that renames one terminal. */
export function terminalRenamePath(id: string): string {
  return `${AGENT_ROUTES.terminals}/${encodeURIComponent(id)}/rename`
}

/** Path that closes one terminal. */
export function terminalClosePath(id: string): string {
  return `${AGENT_ROUTES.terminals}/${encodeURIComponent(id)}/close`
}

/** Encode a path segment after validating it is not empty. */
function segment(value: string): string | undefined {
  if (value === '') return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

const SESSION_PREFIX = `${AGENT_API_PREFIX}/sessions/`
const WORKSPACE_PREFIX = `${AGENT_API_PREFIX}/workspaces/`

/**
 * Match a pathname (without query string) against the agent route table.
 * Returns undefined for unknown paths so the caller can answer 404.
 */
export function matchAgentRoute(pathname: string): AgentRoute | undefined {
  switch (pathname) {
    case AGENT_ROUTES.health:
      return { kind: 'health' }
    case AGENT_ROUTES.host:
      return { kind: 'host' }
    case AGENT_ROUTES.workspaces:
      return { kind: 'workspaces' }
    case AGENT_ROUTES.sessions:
      return { kind: 'sessions' }
    case AGENT_ROUTES.webUrl:
      return { kind: 'web-url' }
    case AGENT_ROUTES.approvalEvents:
      return { kind: 'approval-events' }
    case AGENT_ROUTES.approvalAnswer:
      return { kind: 'approval-answer' }
    case AGENT_ROUTES.fileStat:
      return { kind: 'file-stat' }
    case AGENT_ROUTES.fileList:
      return { kind: 'file-list' }
    case AGENT_ROUTES.fileRead:
      return { kind: 'file-read' }
    case AGENT_ROUTES.fileBytes:
      return { kind: 'file-bytes' }
    case AGENT_ROUTES.fileWatch:
      return { kind: 'file-watch' }
    case AGENT_ROUTES.directories:
      return { kind: 'directory-list' }
    case AGENT_ROUTES.terminals:
      return { kind: 'terminals' }
  }

  if (pathname.startsWith(`${AGENT_ROUTES.terminals}/`)) {
    const rest = pathname.slice(`${AGENT_ROUTES.terminals}/`.length)
    const parts = rest.split('/')
    if (parts.length === 2) {
      const terminalId = segment(parts[0] ?? '')
      if (terminalId === undefined) return undefined
      if (parts[1] === 'attach') return { kind: 'terminal-attach', terminalId }
      if (parts[1] === 'input') return { kind: 'terminal-input', terminalId }
      if (parts[1] === 'rename') return { kind: 'terminal-rename', terminalId }
      if (parts[1] === 'close') return { kind: 'terminal-close', terminalId }
    }
    return undefined
  }

  if (pathname.startsWith(SESSION_PREFIX)) {
    const rest = pathname.slice(SESSION_PREFIX.length)
    const parts = rest.split('/')
    if (parts.length === 1) {
      const sessionId = segment(parts[0] ?? '')
      return sessionId === undefined ? undefined : { kind: 'session', sessionId }
    }
    if (parts.length === 2) {
      const sessionId = segment(parts[0] ?? '')
      if (sessionId === undefined) return undefined
      if (parts[1] === 'events') return { kind: 'session-events', sessionId }
      if (parts[1] === 'assistant-events') return { kind: 'session-assistant-events', sessionId }
      if (parts[1] === 'model') return { kind: 'session-model', sessionId }
      if (parts[1] === 'sandbox') return { kind: 'session-sandbox', sessionId }
      if (parts[1] === 'prompt') return { kind: 'session-prompt', sessionId }
      if (parts[1] === 'cancel') return { kind: 'session-cancel', sessionId }
    }
    return undefined
  }

  if (pathname.startsWith(WORKSPACE_PREFIX) && pathname.endsWith('/sessions')) {
    const rest = pathname.slice(WORKSPACE_PREFIX.length, -'/sessions'.length)
    if (rest === '' || rest.includes('/')) return undefined
    const workspaceId = segment(rest)
    return workspaceId === undefined ? undefined : { kind: 'workspace-sessions', workspaceId }
  }

  return undefined
}
