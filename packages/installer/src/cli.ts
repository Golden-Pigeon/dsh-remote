/**
 * dsh-remote-install CLI entry.
 *
 * @module @dsh-remote/installer/cli
 */

import {
  commandDiscover,
  commandDoctor,
  commandInstall,
  commandPack,
  commandPlan,
  commandTunnel,
} from './commands.ts'
import { HELP, parseArgs, UsageError, type InstallerOptions } from './options.ts'

/** Run one CLI invocation. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let options: InstallerOptions
  try {
    options = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`dsh-remote-install: ${error.message}\n`)
      process.stderr.write('Run "dsh-remote-install help" for usage.\n')
      return 2
    }
    throw error
  }

  try {
    switch (options.command) {
      case 'help':
        process.stdout.write(HELP)
        return 0
      case 'plan':
        process.stdout.write(commandPlan(options))
        return 0
      case 'pack':
        process.stdout.write(`${await commandPack(options)}\n`)
        return 0
      case 'doctor':
        process.stdout.write(await commandDoctor(options))
        return 0
      case 'discover':
        process.stdout.write(`${await commandDiscover(options)}\n`)
        return 0
      case 'tunnel':
        process.stdout.write(`${await commandTunnel(options)}\n`)
        return 0
      case 'install': {
        const output = await commandInstall(options)
        if (output.trim() !== '') process.stdout.write(output.endsWith('\n') ? output : `${output}\n`)
        else process.stdout.write('dsh-remote-install: install finished\n')
        return 0
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`dsh-remote-install: ${message}\n`)
    const detail = error as { result?: { stderr?: string } }
    if (detail.result?.stderr !== undefined && detail.result.stderr.trim() !== '') {
      process.stderr.write(detail.result.stderr)
      if (!detail.result.stderr.endsWith('\n')) process.stderr.write('\n')
    }
    if (options.verbose && error instanceof Error && error.stack !== undefined) {
      process.stderr.write(`${error.stack}\n`)
    }
    return 1
  }
}

