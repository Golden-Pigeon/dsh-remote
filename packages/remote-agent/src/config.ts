/**
 * Agent configuration and path resolution.
 *
 * The agent's only durable artifact is a private JSON state file containing
 * the bearer token, the live port, and liveness metadata. The local plugin
 * discovers it over SSH before opening the tunnel.
 *
 * @module dsh-remote-agent/config
 */

import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** User-facing plugin config (all fields optional in the patch layer). */
export interface Config {
  /** State file path; empty means `$DSH_HOME/remote-agent/agent.json`. */
  readonly stateFile?: string
  /** Fixed bearer token; empty means reuse or mint. */
  readonly token?: string
  /** Reject requests whose peer is not loopback. */
  readonly loopbackOnly?: boolean
  /** Events returned by a snapshot when the caller does not ask for a size. */
  readonly defaultSnapshotEvents?: number
  /** Hard cap on a snapshot request. */
  readonly maxSnapshotEvents?: number
  /** SSE heartbeat interval. */
  readonly heartbeatMs?: number
}

/** Schema validated by the Cordis Loader. */
export const Config: z<Config> = z.object({
  stateFile: z.string().default(''),
  token: z.string().default(''),
  loopbackOnly: z.boolean().default(true),
  defaultSnapshotEvents: z.number().min(1).max(10_000).default(500),
  maxSnapshotEvents: z.number().min(1).max(10_000).default(2_000),
  heartbeatMs: z.number().min(1_000).max(300_000).default(15_000),
})

/** Config with every default materialized. */
export interface ResolvedConfig {
  readonly stateFile: string
  readonly token: string
  readonly loopbackOnly: boolean
  readonly defaultSnapshotEvents: number
  readonly maxSnapshotEvents: number
  readonly heartbeatMs: number
}

/** DSH home: explicit `$DSH_HOME`, otherwise `~/.dsh`. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME
  if (configured !== undefined && configured.trim() !== '') return resolve(configured)
  return join(homedir(), '.dsh')
}

/** Expand a leading `~` and resolve relative paths against the DSH home. */
export function resolveUserPath(path: string, home = resolveDshHome()): string {
  const trimmed = path.trim()
  if (trimmed === '') return join(home, 'remote-agent', 'agent.json')
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/')) return join(home, trimmed.slice(2))
  return isAbsolute(trimmed) ? trimmed : resolve(home, trimmed)
}

/** Directory that owns the state file. */
export function stateDirectory(stateFile: string): string {
  return dirname(stateFile)
}

/** Materialize defaults and resolve the state file. */
export function resolveConfig(config: Config = {}, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const maxSnapshotEvents = config.maxSnapshotEvents ?? 2_000
  const defaultSnapshotEvents = Math.min(config.defaultSnapshotEvents ?? 500, maxSnapshotEvents)
  return {
    stateFile: resolveUserPath(config.stateFile ?? '', resolveDshHome(env)),
    token: (config.token ?? '').trim(),
    loopbackOnly: config.loopbackOnly ?? true,
    defaultSnapshotEvents,
    maxSnapshotEvents,
    heartbeatMs: config.heartbeatMs ?? 15_000,
  }
}
