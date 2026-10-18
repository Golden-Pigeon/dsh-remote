/**
 * Client proxy for workspace-files calls on mirrored Sessions.
 *
 * The Host's generated Remote methods bind the stock workspace-files service
 * before an instance adapter can replace them. The sidebar tree and document
 * preview therefore call this proxy, which asks the local plugin's host API to
 * resolve the mirror and read the remote workspace.
 *
 * @module dsh-remote-local/client/remote-files
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostsApi } from './api.ts'

interface RemoteFace {
  list(sessionId: string, path: string, signal: AbortSignal): Promise<unknown>
  read(sessionId: string, path: string, range: { offset?: number; limit?: number }, signal: AbortSignal): Promise<unknown>
  stat(sessionId: string, path: string, signal: AbortSignal): Promise<unknown>
  readBytes(sessionId: string, path: string, options: { range?: { offset?: number; length?: number }; baseFile?: string }, signal: AbortSignal): Promise<unknown>
  changes(sessionId: string, path: string, signal: AbortSignal): AsyncIterable<unknown>
}

/** Install the proxy on the client Remote face. */
export function installRemoteFiles(ctx: Context, api: HostsApi): void {
  const remote = ctx.remote as unknown as { workspaceFiles?: RemoteFace } | undefined
  const face = remote?.workspaceFiles
  if (face === undefined) return

  const original = {
    list: face.list.bind(face),
    read: face.read.bind(face),
    stat: face.stat.bind(face),
    readBytes: face.readBytes.bind(face),
  }

  face.list = async (sessionId, path, signal) => {
    const result = await api.fileList(sessionId, path)
    return result.mirrored ? { ok: true, value: result.value } : original.list(sessionId, path, signal)
  }
  face.read = async (sessionId, path, range, signal) => {
    const result = await api.fileRead(sessionId, path, range.offset, range.limit)
    return result.mirrored ? { ok: true, value: result.value } : original.read(sessionId, path, range, signal)
  }
  face.stat = async (sessionId, path, signal) => {
    const result = await api.fileStat(sessionId, path)
    return result.mirrored ? { ok: true, value: result.value } : original.stat(sessionId, path, signal)
  }
  face.readBytes = async (sessionId, path, options, signal) => {
    const result = await api.fileBytes(sessionId, path, options.range?.offset, options.range?.length)
    return result.mirrored ? { ok: true, value: result.value } : original.readBytes(sessionId, path, options, signal)
  }
}
