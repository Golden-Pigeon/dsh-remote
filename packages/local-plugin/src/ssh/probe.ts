/**
 * SSH discovery of the remote agent's private state file.
 *
 * This is the only command the local plugin runs before a tunnel exists. It
 * is fixed, bounded, and never interpolates user input into shell syntax.
 *
 * @module dsh-remote-local/ssh/probe
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  isAgentDiscoveryState,
  isAgentLive,
  type AgentDiscoveryState,
} from '@dsh-remote/protocol'
import { LocalError } from '../errors.ts'
import type { ParsedSshTarget } from './target.ts'

const execFileAsync = promisify(execFile)

/** Probe options. */
export interface AgentProbeOptions {
  readonly sshBinary: string
  readonly timeoutMs: number
  readonly strictHostKeyChecking: 'yes' | 'no' | 'ask' | 'accept-new'
  readonly remoteStateFile: string
}

/** Successful discovery. */
export interface DiscoveryResult {
  readonly state: AgentDiscoveryState
  readonly latencyMs: number
}

/** Shell-quote one literal for the fixed remote command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

/** Build the fixed `cat` command for a remote state path. */
export function discoveryCommand(remoteStateFile: string): string {
  const path = remoteStateFile.trim()
  if (path === '') throw new LocalError('host/invalid', 'remote state file must not be empty')
  if (/[\u0000-\u001f]/u.test(path)) {
    throw new LocalError('host/invalid', 'remote state file must not contain control characters')
  }
  if (path === '~') return 'cat -- "$HOME" 2>/dev/null || true'
  if (path.startsWith('~/')) {
    const rest = path.slice(2)
    // Inside double quotes only these characters need escaping. The path comes
    // from plugin config, but quote it correctly instead of trusting that.
    return `cat -- "$HOME/${rest.replace(/([\\"$`])/gu, '\\$1')}" 2>/dev/null || true`
  }
  return `cat -- ${shellQuote(path)} 2>/dev/null || true`
}

/** SSH argv shared by discovery and tunnel startup. */
export function baseSshArgs(target: ParsedSshTarget, options: {
  timeoutMs: number
  strictHostKeyChecking: 'yes' | 'no' | 'ask' | 'accept-new'
}): string[] {
  return [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${Math.max(1, Math.ceil(options.timeoutMs / 1_000))}`,
    '-o', `StrictHostKeyChecking=${options.strictHostKeyChecking}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    ...target.port === null ? [] : ['-p', String(target.port)],
  ]
}

/** Discover one host's running agent. */
export async function discoverAgent(
  target: ParsedSshTarget,
  options: AgentProbeOptions,
): Promise<DiscoveryResult> {
  const started = Date.now()
  const command = discoveryCommand(options.remoteStateFile)
  let stdout: string
  let stderr: string
  try {
    const result = await execFileAsync(
      options.sshBinary,
      [...baseSshArgs(target, options), target.destination, command],
      {
        timeout: options.timeoutMs,
        maxBuffer: 256 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      },
    )
    stdout = result.stdout
    stderr = result.stderr
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean; signal?: string }
    const detail = (failure.stderr ?? '').trim().split('\n')[0] ?? ''
    const message = failure.killed === true
      ? `SSH discovery timed out after ${options.timeoutMs}ms`
      : detail !== ''
        ? `SSH discovery failed: ${detail}`
        : `SSH discovery failed: ${failure.message}`
    throw new LocalError('ssh/probe-failed', message, {
      details: { host: target.canonical, ...failure.code === undefined ? {} : { code: failure.code } },
      cause: error,
    })
  }

  if (stdout.trim() === '') {
    const hint = stderr.trim() === '' ? '' : ` (${stderr.trim().split('\n')[0]})`
    throw new LocalError(
      'agent/unavailable',
      `remote agent state file was not found at ${options.remoteStateFile}; install dsh-remote-agent and start the remote DSH web host${hint}`,
      { details: { host: target.canonical, remoteStateFile: options.remoteStateFile } },
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new LocalError('agent/unavailable', 'remote agent state file is not valid JSON', {
      details: { host: target.canonical },
      cause: error,
    })
  }
  if (!isAgentDiscoveryState(parsed)) {
    throw new LocalError('agent/unavailable', 'remote agent state file has an unexpected shape', {
      details: { host: target.canonical },
    })
  }
  if (!isAgentLive(parsed)) {
    throw new LocalError(
      'agent/unavailable',
      'remote agent is installed but its DSH web listener is not running; start `dsh web` on the remote host',
      { details: { host: target.canonical }, retryable: true },
    )
  }
  return { state: parsed, latencyMs: Date.now() - started }
}
