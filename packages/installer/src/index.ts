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
  BOOTSTRAP_EXIT_CODES,
  InstallerError,
  describeBootstrapExit,
  installerErrorForExit,
} from './errors.ts'
export type { BootstrapExitCode, InstallerErrorCode } from './errors.ts'
export {
  fromOptions,
  renderBootstrapScript,
  renderSystemdUnit,
  shellLiteral,
  shellPath,
} from './bootstrap.ts'
export { HELP, parseArgs, resolveScpBinary, UsageError } from './options.ts'
export type { Command, InstallerOptions, StartMode } from './options.ts'
export { parseTarget, scpArgs, SshTargetError, uploadFile } from './ssh.ts'
export type { ParsedTarget, ScpOptions, SshOptions } from './ssh.ts'
export { provisionRemoteAgent } from './provision.ts'
export type { ProvisionRemoteOptions, ProvisionRemoteResult } from './provision.ts'
