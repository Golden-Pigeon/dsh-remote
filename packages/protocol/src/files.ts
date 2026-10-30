/**
 * Wire types for remote filesystem and directory APIs.
 *
 * Paths are absolute in the remote host's execution world, matching the
 * `workspaceFiles` contract. Binary payloads use base64 JSON because the
 * transport is ordinary HTTP envelopes rather than a binary framing layer.
 *
 * @module @dsh-remote/protocol/files
 */

/** Current metadata for one remote file. */
export interface RemoteFileStat {
  readonly absolutePath: string
  readonly version: string
  readonly bytes?: number
}

/** One line window of a remote text file. */
export interface RemoteFileText extends RemoteFileStat {
  readonly offset: number
  readonly lines: number
  readonly text: string
  readonly eof: boolean
}

/** One byte window of a remote file, base64-encoded on the wire. */
export interface RemoteFileBytes extends RemoteFileStat {
  readonly offset: number
  readonly data: string
  readonly eof: boolean
}

/** One direct child of a remote directory. */
export interface RemoteFileEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
  readonly size?: number
}

/** One remote directory listing. */
export interface RemoteFileListing {
  readonly path: string
  readonly entries: readonly RemoteFileEntry[]
  readonly truncated: boolean
}

/** One remote directory in the workspace-creation picker. */
export interface RemoteDirectoryEntry {
  readonly name: string
  readonly path: string
}

/** Child directories for the workspace-creation picker. */
export interface RemoteDirectoryListing {
  readonly path: string
  readonly parent: string
  readonly entries: readonly RemoteDirectoryEntry[]
  readonly truncated: boolean
}

/** Request for stat/list/read/bytes operations. */
export interface RemoteFileRequest {
  readonly path: string
}

/** Request for a text page. */
export interface RemoteTextReadRequest extends RemoteFileRequest {
  readonly offset?: number
  readonly limit?: number
}

/** Request for a byte window. */
export interface RemoteByteReadRequest extends RemoteFileRequest {
  readonly offset?: number
  readonly length?: number
}

/** One file/directory invalidation frame. */
export type RemoteFileWatchFrame = {
  readonly kind: 'ready'
} | {
  readonly kind: 'change'
  readonly change: {
    readonly absolutePath: string
    readonly version: string
  } | {
    readonly absolutePath: string
    readonly absent: true
  }
}
