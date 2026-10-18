/**
 * Private state file: token, live port, and liveness metadata.
 *
 * The file is written atomically with mode 0600. It is the discovery channel
 * used by the local plugin over SSH; it deliberately contains no DSH API
 * keys, workspace contents, or session data.
 *
 * @module dsh-remote-agent/state
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isValidToken, mintToken } from './auth.ts'
import { stateDirectory } from './config.ts'

/** Current state-file schema version. */
export const STATE_VERSION = 1

/** Discovery document written by a running agent. */
export interface AgentState {
  readonly version: typeof STATE_VERSION
  readonly token: string
  readonly port: number | null
  readonly pid: number
  readonly startedAt: string
  readonly updatedAt: string
  readonly agentVersion: string
  readonly dshVersion: string
  readonly url: string | null
  readonly stoppedAt?: string
}

/** Result of opening the state file before the web listener is known. */
export interface OpenedState {
  readonly state: AgentState
  readonly token: string
  readonly fileExisted: boolean
}

/** Parse and validate a state file's JSON. */
export function parseState(raw: string): AgentState {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`dsh-remote-agent: state file is not valid JSON`, { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('dsh-remote-agent: state file is not a JSON object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== STATE_VERSION) {
    throw new Error(`dsh-remote-agent: unsupported state version ${String(record.version)}`)
  }
  if (typeof record.token !== 'string' || !isValidToken(record.token)) {
    throw new Error('dsh-remote-agent: state file token is malformed')
  }
  if (record.port !== null && (typeof record.port !== 'number' || !Number.isInteger(record.port))) {
    throw new Error('dsh-remote-agent: state file port is malformed')
  }
  if (typeof record.pid !== 'number' || typeof record.startedAt !== 'string') {
    throw new Error('dsh-remote-agent: state file liveness metadata is malformed')
  }
  return {
    version: STATE_VERSION,
    token: record.token,
    port: record.port,
    pid: record.pid,
    startedAt: record.startedAt,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : record.startedAt,
    agentVersion: typeof record.agentVersion === 'string' ? record.agentVersion : 'unknown',
    dshVersion: typeof record.dshVersion === 'string' ? record.dshVersion : 'unknown',
    url: typeof record.url === 'string' ? record.url : null,
    ...typeof record.stoppedAt === 'string' ? { stoppedAt: record.stoppedAt } : {},
  }
}

/** Read an existing state file, or undefined when it does not exist. */
export async function readState(file: string): Promise<AgentState | undefined> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return parseState(raw)
}

/**
 * Open the durable state: reuse the existing token by default, honor an
 * explicitly configured token, and mint when neither is available.
 */
export async function openState(
  file: string,
  configuredToken: string,
  metadata: { readonly agentVersion: string; readonly dshVersion: string },
): Promise<OpenedState> {
  const existing = await readState(file)
  const token = configuredToken !== ''
    ? configuredToken
    : existing?.token ?? mintToken()
  if (!isValidToken(token)) {
    throw new Error(`dsh-remote-agent: token must be at least ${16} characters`)
  }
  const now = new Date().toISOString()
  const state: AgentState = {
    version: STATE_VERSION,
    token,
    port: existing?.port ?? null,
    pid: process.pid,
    startedAt: now,
    updatedAt: now,
    agentVersion: metadata.agentVersion,
    dshVersion: metadata.dshVersion,
    url: existing?.url ?? null,
  }
  return { state, token, fileExisted: existing !== undefined }
}

/** Atomically write the private state file with mode 0600. */
export async function writeState(file: string, state: AgentState): Promise<void> {
  await mkdir(stateDirectory(file), { recursive: true, mode: 0o700 })
  await chmod(stateDirectory(file), 0o700).catch(() => undefined)
  const temp = `${file}.${randomUUID()}.tmp`
  const body = `${JSON.stringify(state, null, 2)}\n`
  await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 })
  await chmod(temp, 0o600)
  await rename(temp, file)
}

/** Build the next state value after the web listener binds. */
export function withListener(
  state: AgentState,
  listener: { readonly port: number; readonly url: string },
  now = new Date().toISOString(),
): AgentState {
  return { ...state, port: listener.port, url: listener.url, updatedAt: now }
}

/** Build the final state value when the plugin unloads. */
export function withStopped(state: AgentState, now = new Date().toISOString()): AgentState {
  return { ...state, port: null, url: null, updatedAt: now, stoppedAt: now }
}

/** Ensure the state directory exists; useful for installer diagnostics. */
export async function ensureStateDirectory(file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
}
