/**
 * Installer commands: plan, pack, install, doctor, discover, tunnel.
 *
 * @module @dsh-remote/installer/commands
 */

import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  isAgentDiscoveryState,
  isAgentLive,
  type AgentDiscoveryState,
} from '@dsh-remote/protocol'
import { fromOptions, nodePathPrelude, shellPath } from './bootstrap.ts'
import type { InstallerOptions } from './options.ts'
import {
  parseTarget,
  quoteRemote,
  runRemote,
  runRemoteScript,
  type ParsedTarget,
  type SshOptions,
} from './ssh.ts'

const execFileAsync = promisify(execFile)

/** Remote directory used for the uploaded plugin tarball. */
const REMOTE_TMP_DIR = '/tmp'

/** Package root of dsh-remote-agent, resolved from source or bundled CLI. */
function agentPackageDir(): string {
  return fileURLToPath(new URL('../../remote-agent', import.meta.url))
}

function sshOptions(options: InstallerOptions): SshOptions {
  return {
    binary: options.sshBinary,
    strictHostKeyChecking: options.strictHostKeyChecking,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  }
}

/** Pack dsh-remote-agent into a temporary directory. */
export async function packAgent(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-agent-pack-'))
  const { stdout } = await execFileAsync('npm', ['pack', '--json', '--pack-destination', dir], {
    cwd: agentPackageDir(),
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  })
  const parsed = JSON.parse(stdout) as Array<{ filename?: unknown }>
  const filename = parsed[0]?.filename
  if (typeof filename !== 'string' || filename === '') {
    throw new Error('npm pack did not report a tarball filename')
  }
  return join(dir, filename)
}

/** Print the bootstrap script without touching the host. */
export function commandPlan(options: InstallerOptions): string {
  const target = requireTarget(options)
  return fromOptions(options, `${REMOTE_TMP_DIR}/dsh-remote-agent-0.2.0.tgz`)
}

/** Pack and print the tarball path. */
export async function commandPack(options: InstallerOptions): Promise<string> {
  const tarball = await packAgent()
  if (options.json) return JSON.stringify({ tarball })
  return `packed ${tarball}`
}

/** Upload the agent and run the bootstrap script. */
export async function commandInstall(options: InstallerOptions): Promise<string> {
  const target = requireTarget(options)
  const tarball = options.agentTarball ?? await packAgent()
  const remoteTarball = `${REMOTE_TMP_DIR}/dsh-remote-agent-${Date.now()}.tgz`
  if (options.verbose) process.stderr.write(`uploading ${tarball} -> ${target.canonical}:${remoteTarball}\n`)
  await uploadFile(tarball, remoteTarball, target, options)
  const script = fromOptions(options, remoteTarball)
  if (options.verbose) process.stderr.write(script)
  const result = await runRemoteScript(target, script, {
    ...sshOptions(options),
    // npm install and DSH boot regularly exceed a short per-command timeout.
    timeoutMs: Math.max(options.timeoutMs, 300_000),
  })
  return result.stdout
}

/** Report remote prerequisites without changing anything. */
export async function commandDoctor(options: InstallerOptions): Promise<string> {
  const target = requireTarget(options)
  const statePath = remoteStatePath(options)
  const script = `set -u
${nodePathPrelude()}
echo "host=$(hostname 2>/dev/null || true)"
echo "home=$HOME"
echo "node=$(command -v node 2>/dev/null || true)"
echo "node_version=$(node --version 2>/dev/null || true)"
echo "npm=$(command -v npm 2>/dev/null || true)"
echo "pnpm=$(command -v pnpm 2>/dev/null || true)"
echo "dsh=$(command -v dsh 2>/dev/null || true)"
echo "systemctl=$(command -v systemctl 2>/dev/null || true)"
echo "install_dir_present=$(test -d ${shellPath(options.installDir)} && echo yes || echo no)"
echo "agent_state=$(test -s ${statePath} && echo present || echo missing)"
`
  const result = await runRemote(target, script, sshOptions(options))
  return result.stdout
}

/** Discover the remote agent state. Never returns the token. */
export async function commandDiscover(options: InstallerOptions): Promise<string> {
  const target = requireTarget(options)
  const state = await discoverState(target, options)
  const summary = {
    host: target.canonical,
    port: state.port,
    live: isAgentLive(state),
    agentVersion: state.agentVersion,
    dshVersion: state.dshVersion,
    startedAt: state.startedAt,
    stateFile: displayStatePath(options),
  }
  if (options.json) return JSON.stringify(summary, null, 2)
  return [
    `host: ${summary.host}`,
    `port: ${String(summary.port)}`,
    `live: ${String(summary.live)}`,
    `agent: ${summary.agentVersion}`,
    `dsh: ${summary.dshVersion}`,
    `started: ${summary.startedAt}`,
    `state: ${summary.stateFile}`,
  ].join('\n')
}

/** Print a ready-to-run tunnel command. */
export async function commandTunnel(options: InstallerOptions): Promise<string> {
  const target = requireTarget(options)
  const state = await discoverState(target, options)
  if (state.port === null) throw new Error('remote agent has no live port; start dsh web first')
  const args = [
    'ssh',
    '-N',
    ...target.port === null ? [] : ['-p', String(target.port)],
    '-o', 'ExitOnForwardFailure=yes',
    '-L', `127.0.0.1:${state.port}:127.0.0.1:${state.port}`,
    target.destination,
  ]
  return args.map(word => /[\s'"]/u.test(word) ? quoteLocal(word) : word).join(' ')
}

/** Read and validate the discovery state over SSH. */
export async function discoverState(target: ParsedTarget, options: InstallerOptions): Promise<AgentDiscoveryState> {
  const command = `cat -- ${remoteStatePath(options)} 2>/dev/null`
  const result = await runRemote(target, command, sshOptions(options))
  if (result.stdout.trim() === '') {
    throw new Error(`remote agent state file not found at ${remoteStatePath(options)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error('remote agent state file is not valid JSON', { cause: error })
  }
  if (!isAgentDiscoveryState(parsed)) throw new Error('remote agent state file has an unexpected shape')
  return parsed
}

function requireTarget(options: InstallerOptions): ParsedTarget {
  if (options.target === undefined) throw new Error('a target is required (--target user@host)')
  return parseTarget(options.target)
}

function remoteStatePath(options: InstallerOptions): string {
  return `${shellPath(options.dshHome)}/"remote-agent/agent.json"`
}

function displayStatePath(options: InstallerOptions): string {
  const home = options.dshHome.trim()
  const suffix = 'remote-agent/agent.json'
  if (home === '~' || home === '$HOME') return `$HOME/${suffix}`
  if (home.startsWith('~/')) return `$HOME/${home.slice(2)}/${suffix}`
  if (home.startsWith('$HOME/')) return `${home}/${suffix}`
  return `${home}/${suffix}`
}

function quoteLocal(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

export function uploadFile(local: string, remote: string, target: ParsedTarget, options: InstallerOptions): Promise<void> {
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
    if (options.verbose) {
      child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    }
  })
}
