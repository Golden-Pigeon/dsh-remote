/**
 * Restart the remote DSH service without reinstalling or touching its profile.
 *
 * The supported deployment uses the user-level systemd unit created by the
 * installer. A nohup deployment has no durable service definition to restart,
 * so it must use Reinstall or an explicit remote command instead.
 *
 * @module dsh-remote-local/remote/restart
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { LocalError } from '../errors.ts'
import { baseSshArgs } from '../ssh/probe.ts'
import type { ParsedSshTarget } from '../ssh/target.ts'

const execFileAsync = promisify(execFile)

export interface RestartRemoteOptions {
  readonly sshBinary: string
  readonly strictHostKeyChecking: 'yes' | 'no' | 'ask' | 'accept-new'
}

const RESTART_COMMAND = [
  'if command -v systemctl >/dev/null 2>&1 && systemctl --user cat dsh-remote-agent.service >/dev/null 2>&1; then',
  '  systemctl --user restart dsh-remote-agent.service',
  'else',
  '  echo "dsh-remote: dsh-remote-agent.service was not found; use Reinstall or restart the remote DSH manually" >&2',
  '  exit 4',
  'fi',
].join('\n')

/** Restart the installer-owned remote DSH unit. */
export async function restartRemoteAgent(
  target: ParsedSshTarget,
  options: RestartRemoteOptions,
): Promise<void> {
  try {
    await execFileAsync(
      options.sshBinary,
      [...baseSshArgs(target, { timeoutMs: 60_000, strictHostKeyChecking: options.strictHostKeyChecking }),
        target.destination, RESTART_COMMAND],
      { timeout: 75_000, maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true },
    )
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean }
    const detail = (failure.stderr ?? '').trim().split('\n')[0] ?? ''
    throw new LocalError(
      'agent/unavailable',
      failure.killed === true
        ? 'remote DSH restart timed out'
        : detail !== ''
          ? `remote DSH restart failed: ${detail}`
          : `remote DSH restart failed: ${failure.message}`,
      { details: { host: target.canonical }, retryable: true, cause: error },
    )
  }
}
