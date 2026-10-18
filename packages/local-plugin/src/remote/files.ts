/**
 * Remote-backed `workspaceFiles` for native workspace trees and file previews.
 *
 * Mirrored workspaces have a local anchor path. The stock workspace-files
 * service would read that empty anchor; this adapter maps the anchor prefix to
 * the remote workspace root and runs a small read-only helper over SSH.
 *
 * @module dsh-remote-local/remote/files
 */

import { spawn } from 'node:child_process'
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
import type { RemoteHostsService } from '../service.ts'
import type { RemoteMirrorService } from '../mirror/service.ts'

const HELPER = String.raw`
import sys, json, os, base64
req = json.load(sys.stdin)
action = req.get('action')
path = req.get('path')
def stat_payload(st):
    return {'absolutePath': path, 'version': f'{st.st_mtime_ns}:{st.st_size}', 'bytes': st.st_size}
try:
    if action == 'stat':
        st = os.stat(path)
        if not os.path.isfile(path):
            raise IsADirectoryError(path)
        print(json.dumps(stat_payload(st)))
    elif action == 'read':
        st = os.stat(path)
        if not os.path.isfile(path):
            raise IsADirectoryError(path)
        offset = max(1, int(req.get('offset', 1)))
        limit = max(1, min(int(req.get('limit', 200)), 2000))
        page = []
        with open(path, 'r', encoding='utf-8') as handle:
            for index, line in enumerate(handle, 1):
                if index < offset:
                    continue
                page.append(line.rstrip('\n'))
                if len(page) > limit:
                    break
        eof = len(page) <= limit
        page = page[:limit]
        text = '\n'.join(page)
        if '\x00' in text:
            raise ValueError('NUL')
        out = stat_payload(st)
        out.update({'offset': offset, 'lines': len(page), 'text': text, 'eof': eof})
        print(json.dumps(out))
    elif action == 'list':
        entries = []
        with os.scandir(path) as it:
            for entry in it:
                try:
                    st = entry.stat(follow_symlinks=True)
                    kind = 'directory' if entry.is_dir(follow_symlinks=True) else ('file' if entry.is_file(follow_symlinks=True) else 'other')
                    size = st.st_size if kind == 'file' else None
                except OSError:
                    kind = 'other'
                    size = None
                item = {'name': entry.name, 'type': kind}
                if size is not None:
                    item['size'] = size
                entries.append(item)
        entries.sort(key=lambda item: item['name'])
        print(json.dumps({'path': req.get('relative', ''), 'entries': entries, 'truncated': len(entries) > 2000}))
    elif action == 'bytes':
        st = os.stat(path)
        offset = max(0, int(req.get('offset', 0)))
        length = max(0, min(int(req.get('length', 5_000_000)), 5_000_000))
        with open(path, 'rb') as handle:
            handle.seek(offset)
            window = handle.read(length)
        print(json.dumps({**stat_payload(st), 'offset': offset, 'data': base64.b64encode(window).decode('ascii'), 'eof': offset + len(window) >= st.st_size}))
    else:
        raise ValueError('unknown action')
except FileNotFoundError:
    print(json.dumps({'error': {'code': 'workspace-file/not-found', 'message': f'not found: {path}'}}))
except IsADirectoryError:
    print(json.dumps({'error': {'code': 'workspace-file/not-regular-file', 'message': f'not a regular file: {path}'}}))
except UnicodeDecodeError:
    print(json.dumps({'error': {'code': 'workspace-file/not-text', 'message': f'not UTF-8 text: {path}'}}))
except Exception as error:
    print(json.dumps({'error': {'code': 'workspace-file/read-failed', 'message': str(error)}}))
`

interface RemoteFileTarget {
  readonly hostId: string
  readonly localPath: string
  readonly remotePath: string
  readonly relativePath: string
  readonly workspaceRoot: string
}

interface HelperError {
  readonly error: { readonly code: string; readonly message: string }
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
    const result = await helper(hosts, target.hostId, {
      action: 'read', path: target.remotePath,
      offset: range.offset ?? 1, limit: range.limit ?? 200,
    }, signal) as unknown as WorkspaceFileText
    return { ...result, absolutePath: target.localPath }
  }

  service.readBytes = async (scope, path, options, signal) => {
    const target = targetOf(mirrors, scope.workspaceRoot, path)
    if (target === undefined) return originalReadBytes(scope, path, options, signal)
    const result = await helper(hosts, target.hostId, {
      action: 'bytes', path: target.remotePath,
      offset: options.range?.offset ?? 0,
      length: options.range?.length ?? 5_000_000,
    }, signal) as unknown as WorkspaceFileBytes & { data: string }
    const bytes = Buffer.from(result.data, 'base64')
    return { ...result, absolutePath: target.localPath, data: bytes }
  }

  service.stat = async (scope, path, signal) => {
    const target = targetOf(mirrors, scope.workspaceRoot, path)
    if (target === undefined) return originalStat(scope, path, signal)
    const result = await helper(hosts, target.hostId, { action: 'stat', path: target.remotePath }, signal) as unknown as WorkspaceFileStat
    return { ...result, absolutePath: target.localPath }
  }

  service.list = async (scope, path, signal) => {
    const target = targetOf(mirrors, scope.workspaceRoot, path)
    if (target === undefined) return originalList(scope, path, signal)
    const result = await helper(hosts, target.hostId, {
      action: 'list', path: target.remotePath, relative: target.relativePath,
    }, signal) as unknown as WorkspaceDirectoryListing
    return { ...result, path: target.relativePath, entries: result.entries.slice(0, 2_000) }
  }

  service.changes = (scope, path, signal) => {
    const target = targetOf(mirrors, scope.workspaceRoot, path)
    if (target === undefined) return originalChanges(scope, path, signal)
    return watch(hosts, target, signal)
  }
}

interface WorkspaceFilesLike {
  read(scope: { workspaceRoot: string }, path: string, range: WorkspaceFileRange, signal: AbortSignal): Promise<WorkspaceFileText>
  readBytes(scope: { workspaceRoot: string }, path: string, options: WorkspaceByteReadOptions, signal: AbortSignal): Promise<WorkspaceFileBytes>
  stat(scope: { workspaceRoot: string }, path: string, signal: AbortSignal): Promise<WorkspaceFileStat>
  list(scope: { workspaceRoot: string }, path: string, signal: AbortSignal): Promise<WorkspaceDirectoryListing>
  changes(scope: { workspaceRoot: string }, path: string, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame>
}

function targetOf(
  mirrors: RemoteMirrorService,
  workspaceRoot: string,
  path: string,
): RemoteFileTarget | undefined {
  const context = mirrors.remoteFileContext(workspaceRoot)
  if (context === undefined) return undefined
  const localPath = isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path)
  const rel = relative(workspaceRoot, localPath)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    const remotePath = rel === '' ? context.remoteRoot : join(context.remoteRoot, rel)
    return {
      hostId: context.hostId,
      localPath: localPath === '' ? workspaceRoot : localPath,
      remotePath,
      relativePath: rel.split(sep).join('/'),
      workspaceRoot,
    }
  }
  return undefined
}

async function helper(
  hosts: RemoteHostsService,
  hostId: string,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const ssh = hosts.sshFor(hostId)
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10000',
    ...ssh.port === null ? [] : ['-p', String(ssh.port)],
    ssh.target,
    'python3', '-c', `'import base64;exec(base64.b64decode("${Buffer.from(HELPER).toString('base64')}"))'`,
  ]
  const result = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(ssh.binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('remote file helper timed out'))
    }, 30_000)
    const abort = (): void => {
      child.kill('SIGKILL')
      reject(new Error('remote file helper aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (code !== 0) reject(new Error(stderr.trim() || `remote file helper exited ${String(code)}`))
      else resolvePromise(stdout)
    })
    child.stdin.end(JSON.stringify(request))
  })
  const line = result.trim().split('\n').at(-1) ?? ''
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(line) as Record<string, unknown>
  } catch {
    throw new Error('remote file helper returned invalid JSON')
  }
  if ('error' in parsed) {
    const failure = parsed as unknown as HelperError
    throw Object.assign(new Error(failure.error.message), { code: failure.error.code })
  }
  return parsed
}

async function* watch(
  hosts: RemoteHostsService,
  target: RemoteFileTarget,
  signal: AbortSignal,
): AsyncGenerator<WorkspaceFileWatchFrame> {
  yield { kind: 'ready' }
  let last = ''
  while (!signal.aborted) {
    try {
      const stat = await helper(hosts, target.hostId, { action: 'stat', path: target.remotePath }, signal) as unknown as WorkspaceFileStat
      if (stat.version !== last) {
        last = stat.version
        yield { kind: 'change', change: { absolutePath: target.localPath, version: stat.version } }
      }
    } catch {
      // A directory watch falls back to the directory's own mtime.
      try {
        const listing = await helper(hosts, target.hostId, {
          action: 'list', path: target.remotePath, relative: target.relativePath,
        }, signal) as unknown as WorkspaceDirectoryListing
        const version = `${listing.entries.length}:${listing.entries.map(entry => `${entry.name}:${entry.size ?? ''}`).join(',')}`
        if (version !== last) {
          last = version
          yield { kind: 'change', change: { absolutePath: target.localPath, version } }
        }
      } catch {
        // Keep watching until the caller aborts.
      }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000))
  }
}
