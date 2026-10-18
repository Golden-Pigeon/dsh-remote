/**
 * Installer options and argument parsing.
 *
 * @module @dsh-remote/installer/options
 */

/** Supported subcommands. */
export type Command = 'install' | 'plan' | 'doctor' | 'discover' | 'tunnel' | 'pack' | 'help'

/** How the remote DSH Web host is supervised after installation. */
export type StartMode = 'systemd' | 'nohup' | 'none'

/** Fully resolved CLI options. */
export interface InstallerOptions {
  readonly command: Command
  readonly target: string | undefined
  readonly profile: string
  readonly port: number
  readonly installDir: string
  readonly dshHome: string
  readonly dshVersion: string
  readonly pnpmVersion: string
  readonly start: StartMode
  readonly agentTarball: string | undefined
  readonly sshBinary: string
  readonly strictHostKeyChecking: 'yes' | 'no' | 'ask' | 'accept-new'
  readonly timeoutMs: number
  readonly json: boolean
  readonly verbose: boolean
}

/** Raised for a usage error. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** Parse `process.argv.slice(2)`. */
export function parseArgs(argv: readonly string[]): InstallerOptions {
  let command: Command = 'install'
  const positional: string[] = []
  let target: string | undefined
  let profile = 'web'
  let port = 0
  let installDir = '$HOME/.local/share/dsh-remote'
  let dshHome = '$HOME/.dsh'
  let dshVersion = '0.2.1-rc.2'
  let pnpmVersion = '11.21.0'
  let start: StartMode = 'systemd'
  let agentTarball: string | undefined
  let sshBinary = 'ssh'
  let strict: InstallerOptions['strictHostKeyChecking'] = 'accept-new'
  let timeoutMs = 30_000
  let json = false
  let verbose = false

  const first = argv[0]
  if (first !== undefined && !first.startsWith('-')) {
    const commands: readonly Command[] = ['install', 'plan', 'doctor', 'discover', 'tunnel', 'pack', 'help']
    if (commands.includes(first as Command)) command = first as Command
    else positional.push(first)
  }

  for (let index = first !== undefined && !first.startsWith('-') && command === first ? 1 : 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (!arg.startsWith('-')) {
      positional.push(arg)
      continue
    }
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    const value = (): string => {
      if (inline !== undefined) return inline
      const next = argv[++index]
      if (next === undefined) throw new UsageError(`${flag} needs a value`)
      return next
    }
    switch (flag) {
      case '-h':
      case '--help':
        command = 'help'
        break
      case '--target':
      case '--host':
      case '-t':
        target = value()
        break
      case '--profile':
        profile = value()
        break
      case '--port':
        port = parseInteger(value(), '--port', 0, 65_535)
        break
      case '--install-dir':
        installDir = value()
        break
      case '--dsh-home':
        dshHome = value()
        break
      case '--dsh-version':
        dshVersion = value()
        break
      case '--pnpm-version':
        pnpmVersion = value()
        break
      case '--start':
        start = parseStart(value())
        break
      case '--no-start':
        start = 'none'
        break
      case '--agent-tarball':
        agentTarball = value()
        break
      case '--ssh':
        sshBinary = value()
        break
      case '--strict-host-key-checking':
        strict = parseStrict(value())
        break
      case '--timeout-ms':
        timeoutMs = parseInteger(value(), '--timeout-ms', 1_000, 600_000)
        break
      case '--json':
        json = true
        break
      case '-v':
      case '--verbose':
        verbose = true
        break
      case '--dry-run':
        start = 'none'
        command = 'plan'
        break
      default:
        throw new UsageError(`unknown option ${flag}`)
    }
  }

  if (target === undefined && positional.length > 0) target = positional[0]
  if ((command === 'install' || command === 'plan' || command === 'doctor' || command === 'discover' || command === 'tunnel') && target === undefined) {
    throw new UsageError(`${command} needs --target user@host[:port]`)
  }

  return {
    command,
    target,
    profile,
    port,
    installDir,
    dshHome,
    dshVersion,
    pnpmVersion,
    start,
    agentTarball,
    sshBinary,
    strictHostKeyChecking: strict,
    timeoutMs,
    json,
    verbose,
  }
}

function parseInteger(raw: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) throw new UsageError(`${flag} must be an integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new UsageError(`${flag} must be between ${min} and ${max}`)
  }
  return value
}

function parseStart(raw: string): StartMode {
  if (raw === 'systemd' || raw === 'nohup' || raw === 'none') return raw
  throw new UsageError('--start must be systemd, nohup, or none')
}

function parseStrict(raw: string): InstallerOptions['strictHostKeyChecking'] {
  if (raw === 'yes' || raw === 'no' || raw === 'ask' || raw === 'accept-new') return raw
  throw new UsageError('--strict-host-key-checking must be yes, no, ask, or accept-new')
}

/** Help text shown by `dsh-remote-install help`. */
export const HELP = `dsh-remote-install — install dsh-remote-agent on an SSH host

Usage:
  dsh-remote-install install --target user@host [options]
  dsh-remote-install plan --target user@host
  dsh-remote-install doctor --target user@host
  dsh-remote-install discover --target user@host
  dsh-remote-install tunnel --target user@host
  dsh-remote-install pack

Options:
  --target, --host, -t     SSH destination (user@host[:port] or ssh config alias)
  --profile                Remote DSH profile (default: web)
  --port                   Remote DSH Web port, 0 lets the OS pick (default: 0)
  --install-dir            Remote install root (default: $HOME/.local/share/dsh-remote)
  --dsh-home               Remote DSH home (default: $HOME/.dsh)
  --dsh-version            @deepseek-ai/dsh version (default: 0.2.1-rc.2)
  --pnpm-version           pnpm version installed into --install-dir (default: 11.21.0)
  --start                  systemd | nohup | none (default: systemd)
  --no-start               Same as --start none
  --agent-tarball          Use an existing dsh-remote-agent .tgz
  --ssh                    SSH binary (default: ssh)
  --strict-host-key-checking  yes | no | ask | accept-new (default: accept-new)
  --timeout-ms             SSH command timeout (default: 30000)
  --json                   Machine-readable output where supported
  -v, --verbose            Stream remote output
  --dry-run                Print the bootstrap script (same as plan)
  -h, --help               Show this help

The remote host needs Node.js 22.19+ and npm. The installer installs pnpm and
DSH into --install-dir when they are not already available, adds
dsh-remote-agent to the chosen profile, and starts \`dsh web\` on 127.0.0.1.
It never copies model API keys; configure credentials on the remote host (or
use the future local credential proxy) separately.
`
