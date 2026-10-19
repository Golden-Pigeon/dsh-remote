/**
 * Pure projections from DSH workspace/session records to wire values.
 *
 * These functions deliberately accept structural shapes instead of importing
 * DSH classes, so the testkit can exercise the exact projection the agent
 * uses without booting Cordis.
 *
 * @module dsh-remote-agent/projection
 */

import type {
  RemoteSessionEvent,
  RemoteSessionSummary,
  RemoteWorkspace,
} from '@dsh-remote/protocol'

/** Structural workspace shape shared by `Workspace` and test fakes. */
export interface WorkspaceLike {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** Structural session header shape. */
export interface SessionHeaderLike {
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  readonly origin?: 'subagent'
  readonly parentSession?: string
}

/** Project one workspace record. */
export function projectWorkspace(workspace: WorkspaceLike): RemoteWorkspace {
  return {
    workspaceId: workspace.id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.sessionIds],
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

/** Project the whole registry order. */
export function projectWorkspaces(workspaces: readonly WorkspaceLike[]): RemoteWorkspace[] {
  return workspaces.map(projectWorkspace)
}

/** Find the workspace owning a session id. */
export function findWorkspaceId(
  workspaces: readonly WorkspaceLike[],
  sessionId: string,
): string | null {
  for (const workspace of workspaces) {
    if (workspace.sessionIds.includes(sessionId)) return workspace.id
  }
  return null
}

/** Project one session summary. */
export function projectSession(input: {
  readonly header: SessionHeaderLike
  readonly live: boolean
  readonly eventCount: number | null
  readonly workspaceId: string | null
}): RemoteSessionSummary {
  return {
    sessionId: input.header.id,
    workspaceId: input.workspaceId,
    cwd: input.header.cwd ?? null,
    createdAt: new Date(input.header.createdAt).toISOString(),
    live: input.live,
    eventCount: input.eventCount,
    ...input.header.origin === undefined ? {} : { origin: input.header.origin },
    ...input.header.parentSession === undefined ? {} : { parentSession: input.header.parentSession },
  }
}

/** Take the newest `limit` entries and report whether older ones were dropped. */
export function takeTail<T>(items: readonly T[], limit: number): { items: T[]; truncated: boolean } {
  if (limit <= 0) return { items: [], truncated: items.length > 0 }
  if (items.length <= limit) return { items: [...items], truncated: false }
  return { items: items.slice(items.length - limit), truncated: true }
}

/** Convert one DSH session event to its wire shape. */
export function toWireEvent(event: {
  readonly seq: number
  readonly type: string
  readonly time: number
  readonly data: unknown
}): RemoteSessionEvent {
  const surface = event as unknown as {
    readonly surfaceOp?: RemoteSessionEvent['surfaceOp']
    readonly sourceEventSeqs?: readonly number[]
  }
  const data = event.type === 'developer/message'
    && typeof event.data === 'object' && event.data !== null && !Array.isArray(event.data)
    ? (() => {
        // headerSeq refers to a request/header sequence in the remote log. A
        // mirror renumbers events, so replaying that remote number makes the
        // local Session reject the developer message. Tool-addition blocks
        // also require the historical header. A mirror does not rebuild model
        // tool state from these events, so keep any text and drop the
        // tool-change blocks and header reference.
        const copy = { ...(event.data as Record<string, unknown>) }
        delete copy.headerSeq
        const message = copy.message
        if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
          const content = (message as { content?: unknown }).content
          if (Array.isArray(content)) {
            copy.message = {
              ...(message as Record<string, unknown>),
              content: content.filter(block => {
                const type = typeof block === 'object' && block !== null ? (block as { type?: unknown }).type : undefined
                return type !== 'tool-addition' && type !== 'tool-removal'
              }),
            }
          }
        }
        return copy
      })()
    : event.data
  return {
    seq: event.seq,
    type: event.type,
    time: event.time,
    data: data as RemoteSessionEvent['data'],
    ...surface.surfaceOp === undefined ? {} : { surfaceOp: surface.surfaceOp },
    ...surface.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: surface.sourceEventSeqs },
  }
}
