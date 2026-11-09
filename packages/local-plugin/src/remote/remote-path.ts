/**
 * Resolve a workspace-file path against a mirrored remote workspace.
 *
 * Mirrored workspaces have two path namespaces: the local anchor (the platform
 * path the sidebar and file tree use) and the remote POSIX root (the path the
 * remote agent uses). Keeping the two namespaces separate is what lets a
 * Windows client browse a Linux workspace.
 *
 * @module dsh-remote-local/remote/remote-path
 */

/** The local and remote forms of one workspace path. */
export interface RemoteFileTarget {
  readonly hostId: string
  readonly localPath: string
  readonly remotePath: string
  readonly relativePath: string
  readonly workspaceRoot: string
}

/** The subset of a path module used to resolve one namespace. */
export interface PathApi {
  isAbsolute(path: string): boolean
  join(...paths: string[]): string
  relative(from: string, to: string): string
  resolve(...paths: string[]): string
  readonly sep: string
}

/** Inputs for one mirrored-workspace path resolution. */
export interface RemotePathRequest {
  readonly hostId: string
  /** Local workspace anchor, in the client platform's path syntax. */
  readonly workspaceRoot: string
  /** Remote workspace root, always in POSIX syntax. */
  readonly remoteRoot: string
  /** Path supplied by the caller: remote absolute, local absolute, or relative. */
  readonly path: string
  /** Platform path module for {@link workspaceRoot}. */
  readonly localPath: PathApi
  /** POSIX path module for {@link remoteRoot}. */
  readonly remotePath: PathApi
}

/**
 * Map one caller path to its local and remote forms.
 *
 * Remote absolute paths win first so transcript links and tool cards keep
 * working. Local anchor paths (absolute or relative) come next. A remote
 * absolute path outside the workspace root is passed through to the host
 * agent, matching transcript/editor behavior.
 *
 * @param request - the two path namespaces and the caller's path.
 * @returns the normalized local path, remote path, and workspace-relative path.
 * @throws when a relative path escapes the local workspace anchor.
 */
export function resolveRemoteFileTarget(request: RemotePathRequest): RemoteFileTarget {
  const { localPath, remotePath } = request
  const anchor = localPath.resolve(request.workspaceRoot)
  const remoteRoot = remotePath.resolve(request.remoteRoot)
  const localContains = (root: string, value: string): boolean => contains(root, value, localPath)
  const remoteContains = (root: string, value: string): boolean => contains(root, value, remotePath)

  if (remotePath.isAbsolute(request.path)) {
    const candidate = remotePath.resolve(request.path)
    if (remoteContains(remoteRoot, candidate)) {
      const relative = remotePath.relative(remoteRoot, candidate)
      return {
        hostId: request.hostId,
        localPath: relative === '' ? anchor : localPath.resolve(anchor, relative),
        remotePath: candidate,
        relativePath: relative,
        workspaceRoot: anchor,
      }
    }
  }

  const candidate = localPath.isAbsolute(request.path)
    ? localPath.resolve(request.path)
    : localPath.resolve(anchor, request.path)
  if (localContains(anchor, candidate)) {
    const relative = localPath.relative(anchor, candidate)
    const remoteRelative = relative.split(localPath.sep).join('/')
    return {
      hostId: request.hostId,
      localPath: candidate,
      remotePath: relative === '' ? remoteRoot : remotePath.join(remoteRoot, remoteRelative),
      relativePath: remoteRelative,
      workspaceRoot: anchor,
    }
  }

  // Remote transcript links and editor paths are not confined to the
  // workspace root. A mirrored workspace identifies the host; an absolute
  // path is then read by that host's agent rather than the local filesystem.
  if (remotePath.isAbsolute(request.path)) {
    return {
      hostId: request.hostId,
      localPath: request.path,
      remotePath: request.path,
      relativePath: request.path,
      workspaceRoot: anchor,
    }
  }

  throw Object.assign(
    new Error(`remote file path is outside the mirrored workspace: ${request.path}`),
    { code: 'workspace-file/not-found' },
  )
}

/** Whether {@link value} is {@link root} or one of its descendants. */
function contains(root: string, value: string, pathApi: PathApi): boolean {
  const relative = pathApi.relative(root, value)
  return relative === ''
    || (!pathApi.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${pathApi.sep}`))
}
