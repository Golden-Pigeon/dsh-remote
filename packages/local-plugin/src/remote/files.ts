/**
 * Remote-backed `workspaceFiles` for native workspace trees and file previews.
 *
 * Mirrored workspaces have a local anchor path. The stock workspace-files
 * service would read that empty anchor; this adapter maps the anchor prefix to
 * the remote workspace root and serves every operation from the remote agent
 * over the existing SSH tunnel.
 *
 * @module dsh-remote-local/remote/files
 */

import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {
  WorkspaceByteReadOptions,
  WorkspaceDirectoryListing,
  WorkspaceFileBytes,
  WorkspaceFileRange,
  WorkspaceFileStat,
  WorkspaceFileText,
  WorkspaceFileWatchFrame,
} from '@deepseek-ai/dsh-api-workspace-files'
import type { AgentCapability, RemoteAgentClient } from '@dsh-remote/protocol'
import { LocalError } from '../errors.ts'
import type { RemoteHostsService } from '../service.ts'
import type { RemoteMirrorService } from '../mirror/service.ts'

interface RemoteFileTarget {
  readonly hostId: string
  readonly localPath: string
  readonly remotePath: string
  readonly relativePath: string
  readonly workspaceRoot: string
}

/** Install the adapter over the host's workspace-files service. */
export function installRemoteWorkspaceFiles(
  ctx: Context,
  mirrors: RemoteMirrorService,
  hosts: RemoteHostsService,
): void {
  const service = ctx.get('workspaceFiles') as unknown as WorkspaceFilesLike | undefined
  if (service === undefined) return

  const originalRead = service.read.bind(service)
  const originalReadBytes = service.readBytes.bind(service)
  const originalStat = service.stat.bind(service)
  const originalList = service.list.bind(service)
  const originalChanges = service.changes.bind(service)

  service.read = async (scope, path, range, signal) => {
    const target = targetOf(mirrors, scope.workspaceRoot, path)
    if (target === undefined) return originalRead(scope, path, range, signal)
    const result = await agentFor(hosts, target.hostId, 'file.read').fileRead(
      target.remotePath,
      range.offset ?? 1,
      range.limit ?? 200,
      signal,
    )
    return { ...result, absolutePath: target.localPath }
  }

  service.readBytes = async (scope, path, options, signal) => {
    const target = targetOf(mirrors, scope.workspaceRoot, path)
    if (target === undefined) return originalReadBytes(scope, path, options, signal)
    const result = await agentFor(hosts, target.hostId, 'file.bytes').fileBytes(
      target.remotePath,
      options.range?.offset ?? 0,
      options.range?.length ?? 5_000_000,
      signal,
    )
    return { ...result, absolutePath: target.localPath, data: Buffer.from(result.data, 'base64') }
  }

  service.stat = async (scope, path, signal) => {
    const target = targetOf(mirrors, scope.workspaceRoot, path)
    if (target === undefined) return originalStat(scope, path, signal)
    const result = await agentFor(hosts, target.hostId, 'file.stat').fileStat(target.remotePath, signal)
    return { ...result, absolutePath: target.localPath }
  }

  service.list = async (scope, path, signal) => {
    const target = targetOf(mirrors, scope.workspaceRoot, path)
    if (target === undefined) return originalList(scope, path, signal)
    const result = await agentFor(hosts, target.hostId, 'file.list').fileList(target.remotePath, signal)
    return { ...result, path: target.relativePath, entries: result.entries.slice(0, 2_000) }
  }

  service.changes = (scope, path, signal) => {
    const target = targetOf(mirrors, scope.workspaceRoot, path)
    if (target === undefined) return originalChanges(scope, path, signal)
    return watchAgent(agentFor(hosts, target.hostId, 'file.watch'), target, signal)
  }
}

interface WorkspaceFilesLike {
  read(scope: { workspaceRoot: string }, path: string, range: WorkspaceFileRange, signal: AbortSignal): Promise<WorkspaceFileText>
  readBytes(scope: { workspaceRoot: string }, path: string, options: WorkspaceByteReadOptions, signal: AbortSignal): Promise<WorkspaceFileBytes>
  stat(scope: { workspaceRoot: string }, path: string, signal: AbortSignal): Promise<WorkspaceFileStat>
  list(scope: { workspaceRoot: string }, path: string, signal: AbortSignal): Promise<WorkspaceDirectoryListing>
  changes(scope: { workspaceRoot: string }, path: string, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame>
}

/** Resolve the agent client or fail with a visible "Reinstall" instruction. */
function agentFor(hosts: RemoteHostsService, hostId: string, capability: AgentCapability): RemoteAgentClient {
  if (!hosts.supportsAgent(hostId, capability)) {
    throw new LocalError(
      'agent/unavailable',
      `remote agent does not advertise ${capability}; reinstall it`,
      { retryable: false, ui: { key: 'error.agentOutdated' } },
    )
  }
  return hosts.agentFor(hostId)
}

function targetOf(
  mirrors: RemoteMirrorService,
  workspaceRoot: string,
  path: string,
): RemoteFileTarget | undefined {
  const context = mirrors.remoteFileContext(workspaceRoot)
  if (context === undefined) return undefined
  const anchor = resolve(workspaceRoot)
  const remoteRoot = resolve(context.remoteRoot)
  const candidate = isAbsolute(path) ? resolve(path) : resolve(anchor, path)
  const contains = (root: string, value: string): boolean => {
    const rel = relative(root, value)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }

  // Tool cards and transcript links use the remote absolute path. The sidebar
  // uses the local anchor. Accept both and normalize to the remote workspace.
  if (isAbsolute(path) && contains(remoteRoot, candidate)) {
    const rel = relative(remoteRoot, candidate)
    return {
      hostId: context.hostId,
      localPath: rel === '' ? anchor : resolve(anchor, rel),
      remotePath: candidate,
      relativePath: rel.split(sep).join('/'),
      workspaceRoot: anchor,
    }
  }

  if (contains(anchor, candidate)) {
    const rel = relative(anchor, candidate)
    const remotePath = rel === '' ? remoteRoot : join(remoteRoot, rel)
    return {
      hostId: context.hostId,
      localPath: candidate,
      remotePath,
      relativePath: rel.split(sep).join('/'),
      workspaceRoot: anchor,
    }
  }
  // Remote transcript links and editor paths are not confined to the
  // workspace root. A mirrored workspace identifies the host; an absolute
  // path is then read by that host's agent rather than the local filesystem.
  if (isAbsolute(path)) {
    return {
      hostId: context.hostId,
      localPath: path,
      remotePath: path,
      relativePath: path,
      workspaceRoot: anchor,
    }
  }

  throw Object.assign(
    new Error(`remote file path is outside the mirrored workspace: ${path}`),
    { code: 'workspace-file/not-found' },
  )
}

async function* watchAgent(
  client: RemoteAgentClient,
  target: RemoteFileTarget,
  signal: AbortSignal,
): AsyncGenerator<WorkspaceFileWatchFrame> {
  let ready = false
  while (!signal.aborted) {
    try {
      for await (const frame of client.followFileChanges(target.remotePath, signal)) {
        if (frame.kind === 'ready') {
          if (!ready) {
            ready = true
            yield { kind: 'ready' }
          }
          continue
        }
        yield {
          kind: 'change',
          change: 'absent' in frame.change
            ? { absolutePath: target.localPath, absent: true }
            : { absolutePath: target.localPath, version: frame.change.version },
        }
      }
    } catch {
      // Reconnect the agent watch until the consumer aborts.
    }
    if (!ready) {
      ready = true
      yield { kind: 'ready' }
    }
    if (signal.aborted) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000))
  }
}
