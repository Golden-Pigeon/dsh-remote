/**
 * Wire types for remote PTY terminals.
 *
 * These are structurally compatible with the DSH terminal-controller frames,
 * but live in the protocol package so the remote agent and local plugin can
 * version them together without importing each other's runtime packages.
 *
 * @module @dsh-remote/protocol/terminal
 */

/** One shell candidate offered by the remote agent. */
export interface RemoteTerminalShell {
  readonly path: string
  readonly args: readonly string[]
  readonly name: string
}

/** Current state of one remote terminal. */
export interface RemoteTerminalInfo {
  readonly id: string
  readonly title: string
  readonly shell: RemoteTerminalShell
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly state: 'running' | 'exited' | 'failed'
  readonly exitCode: number | null
  readonly error?: string
}

/** Request to allocate one remote PTY. */
export interface RemoteTerminalCreateRequest {
  readonly id?: string
  readonly cwd: string
  readonly title?: string
  readonly shellPath?: string
  readonly cols?: number
  readonly rows?: number
}

/** Input/resize command for one remote PTY. */
export type RemoteTerminalInput = {
  readonly type: 'write'
  readonly data: string
} | {
  readonly type: 'resize'
  readonly cols: number
  readonly rows: number
}

/** One attachment frame. Mirrors DSH `TerminalFrame` structurally. */
export type RemoteTerminalFrame = {
  readonly type: 'snapshot'
  readonly sequence: number
  readonly screen: string
  readonly info: RemoteTerminalInfo
  readonly writable: boolean
} | {
  readonly type: 'output'
  readonly sequence: number
  readonly data: string
} | {
  readonly type: 'state'
  readonly info: RemoteTerminalInfo
  readonly writable: boolean
}

/** Result of listing remote terminals. */
export interface RemoteTerminalListResult {
  readonly terminals: readonly RemoteTerminalInfo[]
}
