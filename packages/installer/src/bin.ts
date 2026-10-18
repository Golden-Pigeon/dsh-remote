/**
 * Executable entry for dsh-remote-install.
 *
 * @module @dsh-remote/installer/bin
 */

import { main } from './cli.ts'

process.exitCode = await main()
