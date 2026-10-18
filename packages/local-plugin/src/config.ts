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
  /** Remote discovery document path; empty derives from `remoteDshHome`. */
  readonly remoteStateFile?: string
  readonly probeTimeoutMs?: number
  readonly connectTimeoutMs?: number
  readonly healthIntervalMs?: number
  readonly reconnect?: boolean
  readonly maxReconnectDelayMs?: number
  /** `yes`, `no`, `ask`, or `accept-new`. */
  readonly strictHostKeyChecking?: string
  /** Provision DSH + dsh-remote-agent when discovery finds no agent. */
  readonly autoProvision?: boolean
  readonly remoteDshHome?: string
  readonly remoteInstallDir?: string
  readonly remoteDshVersion?: string
  readonly remotePnpmVersion?: string
  /** Node.js version installed into the remote install dir when none is usable. */
  readonly remoteNodeVersion?: string
  /** Optional HTTP(S) proxy for remote provisioning; empty means auto-detect. */
  readonly remoteInstallProxy?: string
  /** Comma-separated proxy bypass list. */
  readonly remoteInstallNoProxy?: string
  /** Download Node.js into the remote install dir when it is missing or too old. */
  readonly autoInstallNode?: boolean
  /** `systemd`, `nohup`, or `none`. */
  readonly remoteStart?: string
  readonly provisionTimeoutMs?: number
  /** Keep the model key local and proxy it through a reverse SSH tunnel. Default false. */
  readonly credentialProxy?: boolean
  /** Copy the resolved local model key into the remote service environment. */
  readonly copyModelKey?: boolean
  /** Provider base URL used when the key is copied to the remote host. */
  readonly remoteModelBaseUrl?: string
  readonly credentialProxyUpstream?: string
  /** Remote loopback port that receives the reverse-forwarded proxy. */
  readonly credentialProxyRemotePort?: number
  /** Credential reference resolved in the local DSH process. */
  readonly modelCredentialRef?: string
  /** Mirror remote sessions into the local conversation UI. */
  readonly mirrorSessions?: boolean
  /** Poll interval for mirrored remote event logs. */
  readonly mirrorPollMs?: number
  /** Maximum remote events replayed when a mirror is created. */
  readonly mirrorMaxEvents?: number
}

/** Loader-validated schema. */
export const Config: z<Config> = z.object({
  stateDir: z.string().default(''),
  sshBinary: z.string().default('ssh'),
  remoteStateFile: z.string().default(''),
  probeTimeoutMs: z.number().min(1_000).max(120_000).default(10_000),
  connectTimeoutMs: z.number().min(1_000).max(120_000).default(15_000),
  healthIntervalMs: z.number().min(2_000).max(600_000).default(15_000),
  reconnect: z.boolean().default(true),
  maxReconnectDelayMs: z.number().min(1_000).max(600_000).default(30_000),
  strictHostKeyChecking: z.string().default('accept-new'),
  autoProvision: z.boolean().default(true),
  remoteDshHome: z.string().default('~/.dsh'),
  remoteInstallDir: z.string().default('~/.local/share/dsh-remote'),
  remoteDshVersion: z.string().default('0.2.1-rc.2'),
  remotePnpmVersion: z.string().default('11.21.0'),
  remoteNodeVersion: z.string().default('22.19.0'),
  remoteInstallProxy: z.string().default(''),
  remoteInstallNoProxy: z.string().default('127.0.0.1,localhost'),
  autoInstallNode: z.boolean().default(true),
  remoteStart: z.string().default('systemd'),
  provisionTimeoutMs: z.number().min(60_000).max(1_800_000).default(600_000),
  credentialProxy: z.boolean().default(false),
  copyModelKey: z.boolean().default(true),
  remoteModelBaseUrl: z.string().default('https://api.deepseek.com/anthropic'),
  credentialProxyUpstream: z.string().default('https://api.deepseek.com/anthropic'),
  credentialProxyRemotePort: z.number().min(1).max(65_535).default(47_821),
  modelCredentialRef: z.string().default('DEEPSEEK_API_KEY'),
  mirrorSessions: z.boolean().default(true),
  mirrorPollMs: z.number().min(500).max(30_000).default(1_500),
  mirrorMaxEvents: z.number().min(100).max(10_000).default(2_000),
})

/** How the remote DSH web host is supervised after provisioning. */
export type RemoteStartMode = 'systemd' | 'nohup' | 'none'

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
  readonly autoProvision: boolean
  readonly remoteDshHome: string
  readonly remoteInstallDir: string
  readonly remoteDshVersion: string
  readonly remotePnpmVersion: string
  readonly remoteNodeVersion: string
  readonly remoteInstallProxy: string
  readonly remoteInstallNoProxy: string
  readonly autoInstallNode: boolean
  readonly remoteStart: RemoteStartMode
  readonly provisionTimeoutMs: number
  readonly credentialProxy: boolean
  readonly copyModelKey: boolean
  readonly remoteModelBaseUrl: string
  readonly credentialProxyUpstream: string
  readonly credentialProxyRemotePort: number
  readonly modelCredentialRef: string
  readonly mirrorSessions: boolean
  readonly mirrorPollMs: number
  readonly mirrorMaxEvents: number
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

/** Join a remote path expression without resolving it locally. */
export function joinRemotePath(base: string, suffix: string): string {
  const trimmed = base.trim()
  if (trimmed === '' || trimmed === '~') return `~/${suffix}`
  return `${trimmed.replace(/\/+$/u, '')}/${suffix}`
}

/** Materialize defaults. */
export function resolveConfig(config: Config = {}, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const strict = config.strictHostKeyChecking ?? 'accept-new'
  if (strict !== 'yes' && strict !== 'no' && strict !== 'ask' && strict !== 'accept-new') {
    throw new Error(`invalid strictHostKeyChecking: ${JSON.stringify(strict)}`)
  }
  const remoteStart = config.remoteStart ?? 'systemd'
  if (remoteStart !== 'systemd' && remoteStart !== 'nohup' && remoteStart !== 'none') {
    throw new Error(`invalid remoteStart: ${JSON.stringify(remoteStart)}`)
  }
  const remoteDshHome = config.remoteDshHome ?? '~/.dsh'
  const configuredStateFile = (config.remoteStateFile ?? '').trim()
  return {
    stateDir: resolveLocalPath(config.stateDir ?? '', resolveDshHome(env)),
    sshBinary: (config.sshBinary ?? 'ssh').trim() || 'ssh',
    remoteStateFile: configuredStateFile === ''
      ? joinRemotePath(remoteDshHome, 'remote-agent/agent.json')
      : configuredStateFile,
    probeTimeoutMs: config.probeTimeoutMs ?? 10_000,
    connectTimeoutMs: config.connectTimeoutMs ?? 15_000,
    healthIntervalMs: config.healthIntervalMs ?? 15_000,
    reconnect: config.reconnect ?? true,
    maxReconnectDelayMs: config.maxReconnectDelayMs ?? 30_000,
    strictHostKeyChecking: strict,
    autoProvision: config.autoProvision ?? true,
    remoteDshHome,
    remoteInstallDir: config.remoteInstallDir ?? '~/.local/share/dsh-remote',
    remoteDshVersion: config.remoteDshVersion ?? '0.2.1-rc.2',
    remotePnpmVersion: config.remotePnpmVersion ?? '11.21.0',
    remoteNodeVersion: config.remoteNodeVersion ?? '22.19.0',
    remoteInstallProxy: config.remoteInstallProxy ?? '',
    remoteInstallNoProxy: config.remoteInstallNoProxy ?? '127.0.0.1,localhost',
    autoInstallNode: config.autoInstallNode ?? true,
    remoteStart,
    provisionTimeoutMs: config.provisionTimeoutMs ?? 600_000,
    credentialProxy: config.credentialProxy ?? false,
    copyModelKey: config.copyModelKey ?? true,
    remoteModelBaseUrl: config.remoteModelBaseUrl ?? 'https://api.deepseek.com/anthropic',
    credentialProxyUpstream: config.credentialProxyUpstream ?? 'https://api.deepseek.com/anthropic',
    credentialProxyRemotePort: config.credentialProxyRemotePort ?? 47_821,
    modelCredentialRef: config.modelCredentialRef ?? 'DEEPSEEK_API_KEY',
    mirrorSessions: config.mirrorSessions ?? true,
    mirrorPollMs: config.mirrorPollMs ?? 1_500,
    mirrorMaxEvents: config.mirrorMaxEvents ?? 2_000,
  }
}
