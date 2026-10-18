/**
 * Programmatic installer surface.
 *
 * @module @dsh-remote/installer
 */

export { main } from './cli.ts'
export {
  commandDiscover,
  commandDoctor,
  commandInstall,
  commandPack,
  commandPlan,
  commandTunnel,
  discoverState,
  packAgent,
} from './commands.ts'
export {
  fromOptions,
  renderBootstrapScript,
  renderSystemdUnit,
  shellLiteral,
  shellPath,
} from './bootstrap.ts'
export { HELP, parseArgs, UsageError } from './options.ts'
export type { Command, InstallerOptions, StartMode } from './options.ts'
export { parseTarget, SshTargetError } from './ssh.ts'
