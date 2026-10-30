/**
 * Read-only remote directory browser used by the workspace creation UI.
 * It calls the remote agent over the existing SSH tunnel.
 *
 * @module dsh-remote-local/remote/directory
 */

import { LocalError } from '../errors.ts'
import type { RemoteHostsService } from '../service.ts'

export interface RemoteDirectoryEntry {
  readonly name: string
  readonly path: string
}

export interface RemoteDirectoryListing {
  readonly path: string
  readonly parent: string
  readonly entries: readonly RemoteDirectoryEntry[]
  readonly truncated: boolean
}

/** List child directories of one remote path. */
export async function listRemoteDirectories(
  hosts: RemoteHostsService,
  hostId: string,
  path = '~',
): Promise<RemoteDirectoryListing> {
  if (!hosts.supportsAgent(hostId, 'directory.list')) {
    throw new LocalError(
      'agent/unavailable',
      'remote agent does not advertise directory.list; reinstall it',
      { retryable: false, ui: { key: 'error.agentOutdated' } },
    )
  }
  return hosts.agentFor(hostId).listDirectories(path)
}
