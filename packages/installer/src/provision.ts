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

import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { renderBootstrapScript } from './bootstrap.ts'
import type { StartMode } from './options.ts'
import { parseTarget, runRemoteScript } from './ssh.ts'

/** Inputs for one remote provisioning run. */
export interface ProvisionRemoteOptions {
  /** SSH destination (`user@host[:port]` or an SSH config alias). */
  readonly target: string
  /** Local packed dsh-remote-agent tarball. */
  readonly agentTarballPath: string
  readonly sshBinary: string
  readonly strictHostKeyChecking: 'yes' | 'no' | 'ask' | 'accept-new'
  readonly profile: string
  readonly installDir: string
  readonly dshHome: string
  readonly dshVersion: string
  readonly pnpmVersion: string
  readonly start: StartMode
  /** Remote model endpoint, for example the reverse-tunnel credential proxy. */
  readonly modelBaseUrl?: string
  /** Placeholder key for the credential proxy; never the real key. */
  readonly modelApiKey?: string
  readonly timeoutMs?: number
  readonly verbose?: boolean
}

/** Result of a provisioning run. */
export interface ProvisionRemoteResult {
  readonly stdout: string
  readonly stderr: string
  readonly remoteTarball: string
}

/** Upload the agent and run the bootstrap script. */
export async function provisionRemoteAgent(options: ProvisionRemoteOptions): Promise<ProvisionRemoteResult> {
  const target = parseTarget(options.target)
  await access(options.agentTarballPath)
  const remoteTarball = `/tmp/dsh-remote-agent-${Date.now()}-${process.pid}.tgz`
  const timeoutMs = Math.max(options.timeoutMs ?? 600_000, 600_000)

  await uploadFile(options.agentTarballPath, remoteTarball, target, options)
  const script = renderBootstrapScript({
    profile: options.profile,
    port: 0,
    installDir: options.installDir,
    dshHome: options.dshHome,
    dshVersion: options.dshVersion,
    pnpmVersion: options.pnpmVersion,
    start: options.start,
    agentTarball: remoteTarball,
    ...options.modelBaseUrl === undefined ? {} : { modelBaseUrl: options.modelBaseUrl },
    ...options.modelApiKey === undefined ? {} : { modelApiKey: options.modelApiKey },
  })

  const result = await runRemoteScript(target, script, {
    binary: options.sshBinary,
    strictHostKeyChecking: options.strictHostKeyChecking,
    timeoutMs,
    verbose: options.verbose ?? false,
  })
  return { stdout: result.stdout, stderr: result.stderr, remoteTarball }
}

function uploadFile(
  local: string,
  remote: string,
  target: ReturnType<typeof parseTarget>,
  options: ProvisionRemoteOptions,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const args = [
      '-o', `StrictHostKeyChecking=${options.strictHostKeyChecking}`,
      ...target.port === null ? [] : ['-P', String(target.port)],
      local,
      `${target.destination}:${remote}`,
    ]
    const child = execFile('scp', args, { timeout: 120_000 }, error => {
      if (error === null) resolve()
      else reject(error)
    })
    if (options.verbose === true) {
      child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    }
  })
}
