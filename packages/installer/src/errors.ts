/**
 * Installer failure taxonomy.
 *
 * The bootstrap script reports a handful of failures through fixed process
 * exit codes (`exit 21` … `exit 26`). A bare `exited with 24` forces the
 * operator back into the source to learn what happened, so this module is the
 * one place that turns a code into a human-readable cause plus a stable
 * machine code the local plugin can map to localized UI text.
 *
 * @module @dsh-remote/installer/errors
 */

/** Stable installer failure codes surfaced to the local plugin. */
export type InstallerErrorCode =
  /** Node.js is not on the remote PATH and automatic installation is off. */
  | 'install/node-missing'
  /** A Node.js was found but is older than the required minimum. */
  | 'install/node-outdated'
  /** Node.js is present but the distribution ships no npm. */
  | 'install/npm-missing'
  /** `npm install @deepseek-ai/dsh` ran but produced no executable. */
  | 'install/dsh-missing'
  /** The automatic Node.js download/extract/verify step failed. */
  | 'install/node-install-failed'
  /** A legacy `dsh-remote-agent` profile entry could not be migrated. */
  | 'install/profile-migrate-failed'

/** One bootstrap exit code and what it means. */
export interface BootstrapExitCode {
  readonly code: number
  readonly installerCode: InstallerErrorCode
  /** Short operator-facing cause, used in logs and error messages. */
  readonly message: string
}

/**
 * Exit codes the bootstrap script returns on purpose.
 *
 * Keep this in step with the `exit N` statements in `bootstrap.ts`; the
 * test suite asserts every intentional exit code is described here.
 */
export const BOOTSTRAP_EXIT_CODES: readonly BootstrapExitCode[] = [
  {
    code: 21,
    installerCode: 'install/node-missing',
    message: 'Node.js is not on the remote PATH and automatic installation is disabled',
  },
  {
    code: 22,
    installerCode: 'install/node-outdated',
    message: 'the remote Node.js is older than 22.19.0',
  },
  {
    code: 23,
    installerCode: 'install/npm-missing',
    message: 'the remote Node.js installation does not provide npm',
  },
  {
    code: 24,
    installerCode: 'install/dsh-missing',
    message: 'installing @deepseek-ai/dsh produced no executable',
  },
  {
    code: 25,
    installerCode: 'install/node-install-failed',
    message: 'automatic Node.js installation failed',
  },
  {
    code: 26,
    installerCode: 'install/profile-migrate-failed',
    message: 'a legacy dsh-remote-agent profile entry could not be migrated',
  },
]

/** Look up one bootstrap exit code. */
export function describeBootstrapExit(code: number): BootstrapExitCode | undefined {
  return BOOTSTRAP_EXIT_CODES.find(entry => entry.code === code)
}

/** A bootstrap failure that carries both the OS exit code and a stable cause. */
export class InstallerError extends Error {
  readonly installerCode: InstallerErrorCode
  readonly exitCode: number

  constructor(entry: BootstrapExitCode, detail?: string) {
    super(`remote install failed: ${entry.message}${detail === undefined ? '' : `: ${detail}`}`, {
      cause: undefined,
    })
    this.name = 'InstallerError'
    this.installerCode = entry.installerCode
    this.exitCode = entry.code
  }
}

/**
 * Build the failure for one remote exit code, or `undefined` when the code is
 * not one the script produces deliberately (for example a shell error).
 */
export function installerErrorForExit(code: number, detail?: string): InstallerError | undefined {
  const entry = describeBootstrapExit(code)
  return entry === undefined ? undefined : new InstallerError(entry, detail)
}
