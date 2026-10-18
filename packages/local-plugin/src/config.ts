/**
 * Local plugin configuration and path resolution.
 *
 * @module dsh-remote-local/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Raw plugin config. */
export interface Config {
  /** Empty means `$DSH_HOME/remote`. */
  readonly stateDir?: string
  /** SSH executable. */
  readonly sshBinary?: string
  /** Remote discovery document path. */
  readonly remoteStateFile?: string
  readonly probeTimeoutMs?: number
  readonly connectTimeoutMs?: number
  readonly healthIntervalMs?: number
  readonly reconnect?: boolean
  readonly maxReconnectDelayMs?: number
  /** `yes`, `no`, `ask`, or `accept-new`. */
  readonly strictHostKeyChecking?: string
}

/** Loader-validated schema. */
export const Config: z<Config> = z.object({
  stateDir: z.string().default(''),
  sshBinary: z.string().default('ssh'),
  remoteStateFile: z.string().default('~/.dsh/remote-agent/agent.json'),
  probeTimeoutMs: z.number().min(1_000).max(120_000).default(10_000),
  connectTimeoutMs: z.number().min(1_000).max(120_000).default(15_000),
  healthIntervalMs: z.number().min(2_000).max(600_000).default(15_000),
  reconnect: z.boolean().default(true),
  maxReconnectDelayMs: z.number().min(1_000).max(600_000).default(30_000),
  strictHostKeyChecking: z.string().default('accept-new'),
})

/** Resolved config. */
export interface ResolvedConfig {
  readonly stateDir: string
  readonly sshBinary: string
  readonly remoteStateFile: string
  readonly probeTimeoutMs: number
  readonly connectTimeoutMs: number
  readonly healthIntervalMs: number
  readonly reconnect: boolean
  readonly maxReconnectDelayMs: number
  readonly strictHostKeyChecking: 'yes' | 'no' | 'ask' | 'accept-new'
}

/** DSH home. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME
  if (configured !== undefined && configured.trim() !== '') return resolve(configured)
  return join(homedir(), '.dsh')
}

/** Expand `~` and resolve relative paths. */
export function resolveLocalPath(path: string, home = resolveDshHome()): string {
  const trimmed = path.trim()
  if (trimmed === '') return join(home, 'remote')
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/')) return join(home, trimmed.slice(2))
  return isAbsolute(trimmed) ? trimmed : resolve(home, trimmed)
}

/** Materialize defaults. */
export function resolveConfig(config: Config = {}, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const strict = config.strictHostKeyChecking ?? 'accept-new'
  if (strict !== 'yes' && strict !== 'no' && strict !== 'ask' && strict !== 'accept-new') {
    throw new Error(`invalid strictHostKeyChecking: ${JSON.stringify(strict)}`)
  }
  return {
    stateDir: resolveLocalPath(config.stateDir ?? '', resolveDshHome(env)),
    sshBinary: (config.sshBinary ?? 'ssh').trim() || 'ssh',
    remoteStateFile: (config.remoteStateFile ?? '~/.dsh/remote-agent/agent.json').trim(),
    probeTimeoutMs: config.probeTimeoutMs ?? 10_000,
    connectTimeoutMs: config.connectTimeoutMs ?? 15_000,
    healthIntervalMs: config.healthIntervalMs ?? 15_000,
    reconnect: config.reconnect ?? true,
    maxReconnectDelayMs: config.maxReconnectDelayMs ?? 30_000,
    strictHostKeyChecking: strict,
  }
}
