/**
 * Programmatic remote provisioning used by the local plugin.
 *
 * The plugin ships a packed `dsh-remote-agent` tarball as an asset, uploads
 * it over SCP, and pipes the bootstrap script to the remote `bash -s`. This
 * keeps every installation step inside the plugin instead of requiring a
 * separate CLI run.
 *
 * @module @dsh-remote/installer/provision
 */

import { access } from 'node:fs/promises'
import { renderBootstrapScript } from './bootstrap.ts'
import type { StartMode } from './options.ts'
import { parseTarget, runRemoteScript, uploadFile } from './ssh.ts'

/** Inputs for one remote provisioning run. */
export interface ProvisionRemoteOptions {
  /** SSH destination (`user@host[:port]` or an SSH config alias). */
  readonly target: string
  /** Local packed dsh-remote-agent tarball. */
  readonly agentTarballPath: string
  /** Exact npm spec used before the bundled tarball fallback. */
  readonly agentPackageSpec?: string
  readonly sshBinary: string
  /** Extra ssh argv parsed from a full ssh command by the local plugin. */
  readonly sshArgs?: readonly string[]
  /** scp binary; pairs with {@link sshBinary}. */
  readonly scpBinary: string
  readonly strictHostKeyChecking: 'yes' | 'no' | 'ask' | 'accept-new'
  readonly profile: string
  /**
   * Remote `dsh web` port; `0` lets the OS pick one.
   *
   * The local plugin deliberately leaves this at `0` and depends on the
   * published state file instead, so two hosts never collide on a fixed port.
   */
  readonly port?: number
  readonly installDir: string
  readonly dshHome: string
  readonly dshVersion: string
  readonly pnpmVersion: string
  readonly nodeVersion: string
  readonly autoInstallNode: boolean
  /** Replace the installed DSH runtime instead of only installing when missing. */
  readonly upgrade?: boolean
  readonly start: StartMode
  /** Remote model endpoint, for example the reverse-tunnel credential proxy. */
  readonly modelBaseUrl?: string
  /** Placeholder key for the credential proxy; never the real key. */
  readonly modelApiKey?: string
  readonly timeoutMs?: number
  readonly verbose?: boolean
  /** Human-readable bootstrap lines, used by the Settings progress card. */
  readonly onProgress?: (line: string) => void
  /** Proxy URL as seen from the remote host. */
  readonly proxyUrl?: string
  readonly noProxy?: string
}

/** Result of a provisioning run. */
export interface ProvisionRemoteResult {
  readonly stdout: string
  readonly stderr: string
  readonly remoteTarball: string
}

/** Upload the agent and run the bootstrap script. */
export async function provisionRemoteAgent(options: ProvisionRemoteOptions): Promise<ProvisionRemoteResult> {
  const parsed = parseTarget(options.target)
  const target = options.sshArgs === undefined || options.sshArgs.length === 0
    ? parsed
    : { ...parsed, sshArgs: [...options.sshArgs] }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535)) {
    throw new RangeError(`port must be an integer between 0 and 65535 (got ${String(options.port)})`)
  }
  await access(options.agentTarballPath)
  const remoteTarball = `/tmp/dsh-remote-agent-${Date.now()}-${process.pid}.tgz`
  const timeoutMs = Math.max(options.timeoutMs ?? 600_000, 600_000)

  options.onProgress?.('dsh-remote: uploading agent package')
  await uploadFile(options.agentTarballPath, remoteTarball, target, {
    binary: options.scpBinary,
    strictHostKeyChecking: options.strictHostKeyChecking,
    verbose: options.verbose ?? false,
    // provisionTimeoutMs bounds the bootstrap script, not the upload; keeping
    // the upload's own 120s bound avoids a 600s hang on a dead connection.
    timeoutMs: 120_000,
  })
  options.onProgress?.('dsh-remote: agent package uploaded')
  const script = renderBootstrapScript({
    profile: options.profile,
    port: options.port ?? 0,
    installDir: options.installDir,
    dshHome: options.dshHome,
    dshVersion: options.dshVersion,
    pnpmVersion: options.pnpmVersion,
    nodeVersion: options.nodeVersion,
    autoInstallNode: options.autoInstallNode,
    upgrade: options.upgrade === true,
    start: options.start,
    agentTarball: remoteTarball,
    ...options.modelBaseUrl === undefined ? {} : { modelBaseUrl: options.modelBaseUrl },
    ...options.modelApiKey === undefined ? {} : { modelApiKey: options.modelApiKey },
    ...options.agentPackageSpec === undefined ? {} : { agentPackageSpec: options.agentPackageSpec },
    ...options.proxyUrl === undefined ? {} : { proxyUrl: options.proxyUrl },
    ...options.noProxy === undefined ? {} : { noProxy: options.noProxy },
  })

  let stdoutBuffer = ''
  let stderrBuffer = ''
  const emitLines = (stream: 'stdout' | 'stderr', chunk: string): void => {
    const key = stream === 'stdout' ? 'stdout' : 'stderr'
    let buffer = key === 'stdout' ? stdoutBuffer : stderrBuffer
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line !== '') {
        try {
          options.onProgress?.(line)
        } catch {
          // Progress reporting must never break the installer.
        }
      }
      newline = buffer.indexOf('\n')
    }
    if (buffer.length > 8192) buffer = buffer.slice(-8192)
    if (key === 'stdout') stdoutBuffer = buffer
    else stderrBuffer = buffer
  }
  const result = await runRemoteScript(target, script, {
    binary: options.sshBinary,
    strictHostKeyChecking: options.strictHostKeyChecking,
    timeoutMs,
    verbose: options.verbose ?? false,
    onOutput: emitLines,
  })
  return { stdout: result.stdout, stderr: result.stderr, remoteTarball }
}
